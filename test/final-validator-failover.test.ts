/**
 * EHAC-3622 gap 1: the pure contract of the final-validator failover. The orchestrator
 * wiring is driven end to end in final-validator-failover-e2e.test.ts.
 *
 *   - only `stall` and `invalid_output` fail over; `timeout` (falsified, run 32105023640)
 *     and every other class do not;
 *   - once, to the pinned model, never a third attempt;
 *   - only within what the LIVE job clock leaves, never below the floor;
 *   - a pinned model with the validator's identity is refused at preflight;
 *   - an unset input is today's single attempt, record and logs included.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseValidatorFailoverModelInput } from "../src/github/context";
import {
  assessSerialBudget,
  resolveSynthesisRetrySeconds,
  SYNTHESIS_RETRY_MIN_SECONDS,
  type SynthesisRetryBudgetInput,
} from "../src/review/serial-budget";
import {
  costEstimateSynthesisModels,
  resolveSynthesisRetry,
  resolveValidatorFailoverModel,
  SYNTHESIS_FAILOVER_CLASSES,
  type ModelSpec,
} from "../src/review/strategy";
import { executeSynthesisWithFailover, type SynthesisAttemptOverrides } from "../src/review/synthesis-execution";
import type { PiFailureClass, PiRunResult } from "../src/types";

const FLASH: ModelSpec = {
  provider: "openrouter",
  model: "openrouter/deepseek/deepseek-v4.1-flash",
  label: "openrouter/deepseek/deepseek-v4.1-flash",
};
const PRO: ModelSpec = {
  provider: "openrouter",
  model: "openrouter/deepseek/deepseek-v4-pro-0813",
  label: "openrouter/deepseek/deepseek-v4-pro-0813",
};

/** The org config: V = 1200s, job_timeout_minutes = 65. */
const clock = (elapsedSeconds: number, overrides: Partial<SynthesisRetryBudgetInput> = {}): SynthesisRetryBudgetInput => ({
  validatorSeconds: 1200,
  jobTimeoutMinutes: 65,
  elapsedSeconds,
  ...overrides,
});

function piResult(modelLabel: string, overrides: Partial<PiRunResult> = {}): PiRunResult {
  return {
    conclusion: "success",
    output: "## Review",
    turnsUsed: 3,
    providerRetries: 0,
    durationSeconds: 100,
    costUsd: 0.02,
    usage: { inputTokens: 57608, outputTokens: 900, estimated: false, modelLabel, source: "provider" },
    ...overrides,
  };
}
const fail = (modelLabel: string, failureClass: PiFailureClass, overrides: Partial<PiRunResult> = {}) =>
  piResult(modelLabel, { conclusion: "failure", output: `failed: ${failureClass}`, failureClass, ...overrides });

function scripted(results: PiRunResult[]) {
  const calls: Array<{ model: string; promptName: string; overrides?: SynthesisAttemptOverrides }> = [];
  const events: string[] = [];
  let i = 0;
  return {
    calls,
    events,
    runAttempt: async (model: ModelSpec, promptName: string, overrides?: SynthesisAttemptOverrides) => {
      calls.push({ model: model.label, promptName, ...(overrides ? { overrides } : {}) });
      events.push(`run:${promptName}`);
      return results[Math.min(i++, results.length - 1)];
    },
  };
}

async function synthesize(params: {
  results: PiRunResult[];
  pinned?: ModelSpec;
  elapsedSeconds?: number;
  budget?: Partial<SynthesisRetryBudgetInput>;
}) {
  const run = scripted(params.results);
  const logs: string[] = [];
  const out = await executeSynthesisWithFailover({
    validator: FLASH,
    validatorFailoverModel: params.pinned,
    deps: {
      runAttempt: run.runAttempt,
      retryBudget: () => clock(params.elapsedSeconds ?? 1216, params.budget),
      beforeRetry: () => run.events.push("beforeRetry"),
      log: (m) => logs.push(`log:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
    },
  });
  return { run, out, logs };
}

describe("executeSynthesisWithFailover (EHAC-3622)", () => {
  it.each(["stall", "invalid_output"] as const)(
    "a synthesis ending %s fails over ONCE to the pinned model, on the live-clock budget",
    async (failureClass) => {
      // Run 39038897722: the synthesis failed 1216s into the action.
      const { run, out, logs } = await synthesize({ results: [fail(FLASH.label, failureClass), piResult(PRO.label)], pinned: PRO });

      expect(run.calls).toEqual([
        { model: FLASH.label, promptName: "prompt" },
        { model: PRO.label, promptName: "prompt-failover", overrides: { runTimeoutSeconds: 1200 } },
      ]);
      expect(run.events).toEqual(["run:prompt", "beforeRetry", "run:prompt-failover"]);
      expect(out.result.conclusion).toBe("success");
      expect(out.activeModel).toBe(PRO);
      expect(out.retried).toBe(true);
      expect(out.failoverUsed).toBe(true);
      expect(out.attempts).toHaveLength(2);
      expect(out.attemptMetrics.map((m) => [m.attempt, m.failover, m.assignedModel, m.actualModel, m.conclusion, m.runTimeoutSeconds])).toEqual([
        [1, false, FLASH.label, FLASH.label, "failure", undefined],
        [2, true, FLASH.label, PRO.label, "success", 1200],
      ]);
      expect(logs.some((l) => l.startsWith("warn:") && l.includes(`class=${failureClass}`) && l.includes(PRO.label))).toBe(true);
    },
  );

  it("both attempts failing: the failover's result is decisive, both are recorded, and there is no third", async () => {
    const { run, out } = await synthesize({
      results: [fail(FLASH.label, "stall"), fail(PRO.label, "stall"), piResult(FLASH.label)],
      pinned: PRO,
    });

    expect(run.calls.map((c) => c.model)).toEqual([FLASH.label, PRO.label]);
    expect(out.result.conclusion).toBe("failure");
    expect(out.attemptMetrics.map((m) => [m.attempt, m.failureClass])).toEqual([
      [1, "stall"],
      [2, "stall"],
    ]);
  });

  it.each(["timeout", "max_turns", "provider_transient", "provider_unavailable", "provider_permanent", "process_error", "unknown"] as const)(
    "a synthesis ending %s is NOT retried, even with a pinned model",
    async (failureClass) => {
      const { run, out, logs } = await synthesize({ results: [fail(FLASH.label, failureClass), piResult(PRO.label)], pinned: PRO });

      expect(run.calls.map((c) => c.model)).toEqual([FLASH.label]);
      expect(run.events).not.toContain("beforeRetry");
      expect(out.retried).toBe(false);
      expect(out.result.conclusion).toBe("failure");
      expect(logs).toEqual([
        `warn:[validator] synthesis attempt 1 failed (class=${failureClass}) and is NOT retried: ` +
          `failure class "${failureClass}" does not fail the final validator over; only stall and invalid_output do`,
      ]);
    },
  );

  it("an unclassified failure (runPi threw) is not retried", async () => {
    const { run } = await synthesize({ results: [fail(FLASH.label, "stall", { failureClass: undefined })], pinned: PRO });
    expect(run.calls).toHaveLength(1);
  });

  it("the live clock near the cap: NO retry, and the log says why", async () => {
    // 65-minute job, 3540s spent: 3900 - 37 - 3540 - 60 = 263s left, under the 300s floor.
    const { run, out, logs } = await synthesize({ results: [fail(FLASH.label, "stall"), piResult(PRO.label)], pinned: PRO, elapsedSeconds: 3540 });

    expect(run.calls.map((c) => c.model)).toEqual([FLASH.label]);
    expect(out.retried).toBe(false);
    expect(out.result.conclusion).toBe("failure");
    expect(logs).toEqual([
      "warn:[validator] synthesis attempt 1 failed (class=stall) and is NOT retried: the live job clock cannot " +
        "cover a failover synthesis: 3577s of the 3900s job are spent, leaving less than the 300s minimum " +
        "after the margin",
    ]);
  });

  it("the live clock binds: the failover gets only what is left, when that clears the floor", async () => {
    // 3900 - 37 - 3400 - 60 = 403s.
    const { run } = await synthesize({ results: [fail(FLASH.label, "invalid_output"), piResult(PRO.label)], pinned: PRO, elapsedSeconds: 3400 });
    expect(run.calls[1]).toEqual({ model: PRO.label, promptName: "prompt-failover", overrides: { runTimeoutSeconds: 403 } });
  });

  it("an unset job cap: NO retry, because no budget can be proven", async () => {
    const { run, logs } = await synthesize({
      results: [fail(FLASH.label, "stall"), piResult(PRO.label)],
      pinned: PRO,
      budget: { jobTimeoutMinutes: undefined },
    });
    expect(run.calls).toHaveLength(1);
    expect(logs[0]).toContain("job_timeout_minutes is unset");
  });

  it("an UNSET input is today's single attempt: same record, no retry, and not one extra log line", async () => {
    const stalled = fail(FLASH.label, "stall", {
      durationSeconds: 132.74,
      turnsUsed: 1,
      terminationReason: "stall",
      timeToFirstEventSeconds: 2.4,
      maxIdleSecondsObserved: 120.1,
      streamEventCount: 7,
      lastEventType: "message_start",
    });
    let budgetReads = 0;
    const run = scripted([stalled, piResult(PRO.label)]);
    const logs: string[] = [];
    const out = await executeSynthesisWithFailover({
      validator: FLASH,
      validatorFailoverModel: undefined,
      deps: {
        runAttempt: run.runAttempt,
        retryBudget: () => {
          budgetReads++;
          return clock(10);
        },
        log: (m) => logs.push(m),
        warn: (m) => logs.push(m),
      },
    });

    expect(run.calls).toEqual([{ model: FLASH.label, promptName: "prompt" }]);
    expect(budgetReads).toBe(0);
    expect(logs).toEqual([]);
    expect(out.retried).toBe(false);
    expect(out.failoverUsed).toBe(false);
    // The literal record run.ts emitted for the synthesis before EHAC-3622, key order included.
    expect(JSON.stringify(out.attemptMetrics)).toBe(
      JSON.stringify([
        {
          lensId: "validator",
          lensTitle: "Orchestrator synthesis",
          role: "validator",
          attempt: 1,
          assignedModel: FLASH.label,
          actualModel: FLASH.label,
          failover: false,
          conclusion: "failure",
          failureClass: "stall",
          terminationReason: "stall",
          durationSeconds: 132.7,
          turnsUsed: 1,
          providerRetries: 0,
          inputTokens: 57608,
          outputTokens: 900,
          costUsd: 0.02,
          timeToFirstEventSeconds: 2.4,
          maxIdleSecondsObserved: 120.1,
          streamEventCount: 7,
          malformedLineCount: 0,
          lastEventType: "message_start",
        },
      ]),
    );
  });

  it("a successful first synthesis never reads the clock or retries", async () => {
    const { run, out } = await synthesize({ results: [piResult(FLASH.label)], pinned: PRO });
    expect(run.calls).toHaveLength(1);
    expect(out.retried).toBe(false);
  });
});

describe("resolveSynthesisRetry (EHAC-3622)", () => {
  const base = {
    conclusion: "failure" as const,
    attemptsSoFar: 1,
    assignedModel: FLASH,
    validatorFailoverModel: PRO,
    budget: clock(1216),
  };

  it("fails over on exactly stall and invalid_output", () => {
    expect([...SYNTHESIS_FAILOVER_CLASSES]).toEqual(["stall", "invalid_output"]);
    const all: PiFailureClass[] = [
      "stall", "timeout", "max_turns", "invalid_output", "provider_transient",
      "provider_unavailable", "provider_permanent", "process_error", "unknown",
    ];
    expect(all.filter((failureClass) => resolveSynthesisRetry({ ...base, failureClass }).retry)).toEqual([
      "stall",
      "invalid_output",
    ]);
  });

  it("refuses a third attempt", () => {
    const third = resolveSynthesisRetry({ ...base, failureClass: "stall", attemptsSoFar: 2 });
    expect(third.retry).toBe(false);
    expect(third.reason).toContain("exhausted");
  });

  it("refuses a pinned model with the validator's identity, whatever the route", () => {
    const sameOtherRoute: ModelSpec = { provider: "deepseek", model: "deepseek/deepseek-v4.1-flash", label: "deepseek/deepseek-v4.1-flash" };
    expect(resolveSynthesisRetry({ ...base, failureClass: "stall", validatorFailoverModel: sameOtherRoute }).retry).toBe(false);
  });

  it("no pinned model, no budget: no retry", () => {
    expect(resolveSynthesisRetry({ ...base, failureClass: "stall", validatorFailoverModel: undefined }).retry).toBe(false);
    expect(resolveSynthesisRetry({ ...base, failureClass: "stall", budget: undefined }).retry).toBe(false);
  });
});

describe("resolveSynthesisRetrySeconds: the live-clock gate (EHAC-3622)", () => {
  it("affords the full validator budget early in the job", () => {
    expect(resolveSynthesisRetrySeconds(clock(1216))).toBe(1200);
  });

  it("gives only what is left once the clock binds", () => {
    // 3900 - 37 - 2500 - 60 = 1303 -> V; 3900 - 37 - 3000 - 60 = 803.
    expect(resolveSynthesisRetrySeconds(clock(2500))).toBe(1200);
    expect(resolveSynthesisRetrySeconds(clock(3000))).toBe(803);
  });

  it("counts the MEASURED job clock when the steps before the action ran longer than 37s", () => {
    // 180s before the action, 3400s inside it: 3580s spent, 3900 - 3580 - 60 = 260 < 300.
    expect(resolveSynthesisRetrySeconds(clock(3400, { jobElapsedSeconds: 3580 }))).toBeUndefined();
    // 200s before the action, 3000s inside: 3900 - 3200 - 60 = 640.
    expect(resolveSynthesisRetrySeconds(clock(3000, { jobElapsedSeconds: 3200 }))).toBe(640);
    // A measured clock SHORTER than setup + elapsed never grows the budget.
    expect(resolveSynthesisRetrySeconds(clock(3000, { jobElapsedSeconds: 100 }))).toBe(803);
    expect(resolveSynthesisRetrySeconds(clock(3000, { jobElapsedSeconds: Number.NaN }))).toBe(803);
  });

  it(`refuses below the ${SYNTHESIS_RETRY_MIN_SECONDS}s floor, at the boundary exactly`, () => {
    // 3900 - 37 - 3503 - 60 = 300: allowed. One second later: 299, refused.
    expect(resolveSynthesisRetrySeconds(clock(3503))).toBe(300);
    expect(resolveSynthesisRetrySeconds(clock(3504))).toBeUndefined();
    expect(resolveSynthesisRetrySeconds(clock(3540))).toBeUndefined();
    expect(resolveSynthesisRetrySeconds(clock(5000))).toBeUndefined();
  });

  it("never asks a failover for more than the first attempt had: a V below the floor lowers it", () => {
    expect(resolveSynthesisRetrySeconds(clock(10, { validatorSeconds: 240 }))).toBe(240);
    // 4 x 60 - 37 - 10 - 60 = 133 < V = 240: the clock binds, and 133 < 240 is refused.
    expect(resolveSynthesisRetrySeconds(clock(10, { validatorSeconds: 240, jobTimeoutMinutes: 4 }))).toBeUndefined();
  });

  it("an unknown cap or an unreadable clock proves nothing", () => {
    expect(resolveSynthesisRetrySeconds(clock(10, { jobTimeoutMinutes: undefined }))).toBeUndefined();
    expect(resolveSynthesisRetrySeconds(clock(Number.NaN))).toBeUndefined();
  });
});

describe("validator_failover_model input and preflight (EHAC-3622)", () => {
  const inputs = { provider: "openrouter", model: "openrouter/z-ai/glm-5.3-flash" };

  it("empty is the shipped default: no failover", () => {
    expect(parseValidatorFailoverModelInput("")).toBeUndefined();
    expect(parseValidatorFailoverModelInput("   ")).toBeUndefined();
    expect(resolveValidatorFailoverModel(inputs, FLASH)).toBeUndefined();
    expect(resolveValidatorFailoverModel({ ...inputs, validatorFailoverModel: " " }, FLASH)).toBeUndefined();
  });

  it.each([`${PRO.label},${FLASH.label}`, `${PRO.label} ${FLASH.label}`])("refuses a list (%p), naming the input", (bad) => {
    expect(() => parseValidatorFailoverModelInput(bad)).toThrow(/validator_failover_model/);
  });

  it("resolves a distinct pinned model", () => {
    expect(resolveValidatorFailoverModel({ ...inputs, validatorFailoverModel: PRO.label }, FLASH)).toEqual(PRO);
  });

  it.each([FLASH.label, "deepseek/deepseek-v4.1-flash", "OpenRouter/DeepSeek/DeepSeek-V4.1-Flash"])(
    "refuses %p: the validator's identity (last two path segments)",
    (pinned) => {
      expect(() => resolveValidatorFailoverModel({ ...inputs, validatorFailoverModel: pinned }, FLASH)).toThrow(
        /validator_failover_model.*same model as the validator.*last two path segments/s,
      );
    },
  );

  it("compares against the EFFECTIVE validator, including the primary-model fallback", () => {
    const primaryAsValidator: ModelSpec = { provider: "openrouter", model: inputs.model, label: inputs.model };
    expect(() =>
      resolveValidatorFailoverModel({ ...inputs, validatorFailoverModel: "z-ai/glm-5.3-flash" }, primaryAsValidator),
    ).toThrow(/same model as the validator/);
  });
});

describe("budgets outside the live clock (EHAC-3622)", () => {
  it("the static serial guard is unchanged and the org config still fits it", () => {
    const org = assessSerialBudget({ runTimeoutSeconds: 900, validatorRunTimeoutSeconds: 1200, jobTimeoutMinutes: 65 });
    expect(org.outcome).toBe("pass");
    expect(org.message).toContain("= 3637s <= 65 x 60 = 3900s");
  });

  it("the max_cost_usd estimate prices the pinned failover synthesis only when it can run", () => {
    expect(costEstimateSynthesisModels(FLASH, undefined, 65)).toEqual([FLASH]);
    expect(costEstimateSynthesisModels(FLASH, PRO, 65)).toEqual([FLASH, PRO]);
    // No job cap: the failover can never run, so it is not reserved for.
    expect(costEstimateSynthesisModels(FLASH, PRO, undefined)).toEqual([FLASH]);
    const sameOtherRoute: ModelSpec = { provider: "deepseek", model: "deepseek/deepseek-v4.1-flash", label: "deepseek/deepseek-v4.1-flash" };
    expect(costEstimateSynthesisModels(FLASH, sameOtherRoute, 65)).toEqual([FLASH]);
  });

  it("run.ts prices the pre-run estimate through costEstimateSynthesisModels with the pinned model", () => {
    const run = readFileSync(join(import.meta.dir, "..", "src", "entrypoints", "run.ts"), "utf-8");
    expect(run).toMatch(
      /const estimatePlannedInputCost = [\s\S]*?costEstimateSynthesisModels\(plan\.validator, validatorFailoverModel, parsedInputs\.jobTimeoutMinutes\)\.map\(/,
    );
  });
});
