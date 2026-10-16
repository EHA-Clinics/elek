/**
 * EHAC-2522 — the validator-review lane fails over ONCE on `invalid_output`, to a
 * caller-pinned model, and only when the caller pinned one.
 *
 * Evidence: eha_care #4710, council run 38797605889. validator-self-review on
 * openrouter/deepseek/deepseek-v4-pro-0813 ended `invalid_output` after 470.6s;
 * four reviewer lenses had succeeded and were discarded because a failed validator
 * role breaches the council at any tolerance.
 *
 * The properties asserted here, end to end through the council policy:
 *   - invalid_output fails over exactly once, to the pinned model;
 *   - a second invalid_output still breaches;
 *   - timeout / stall / max_turns never fail over on the validator lane;
 *   - an empty config is today's policy outcome, byte for byte;
 *   - the serial-budget guard counts the extra attempt.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { evaluateCouncilPolicy, type CouncilPolicyRun } from "../src/review/council-policy";
import { executeLensWithRetry } from "../src/review/lens-execution";
import { assessSerialBudget } from "../src/review/serial-budget";
import {
  resolveLensRetry,
  resolveValidatorReviewFailoverModel,
  type ModelSpec,
  type ReviewJob,
} from "../src/review/strategy";
import { parseValidatorReviewFailoverModelInput } from "../src/github/context";
import type { PiFailureClass, PiRunResult } from "../src/types";

const ADVISOR: ModelSpec = {
  provider: "openrouter",
  model: "openrouter/deepseek/deepseek-v4-pro-0813",
  label: "openrouter/deepseek/deepseek-v4-pro-0813",
};
const PINNED: ModelSpec = { provider: "openai", model: "openai/gpt-5.5", label: "openai/gpt-5.5" };
const MIMO: ModelSpec = { provider: "xiaomi", model: "xiaomi/mimo-v2.5-pro", label: "xiaomi/mimo-v2.5-pro" };
const FLASH: ModelSpec = { provider: "deepseek", model: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash" };
// The reviewer roster deliberately excludes PINNED: if a failover ever lands on a
// roster model instead of the pinned one, the model assertions below go red.
const ROSTER = [MIMO, FLASH];

const auditJob: ReviewJob = {
  lens: { id: "validator-self-review", title: "Orchestrator Independent Audit", focus: "audit" },
  model: ADVISOR,
  role: "validator-review",
};

function piResult(modelLabel: string, overrides: Partial<PiRunResult> = {}): PiRunResult {
  return {
    conclusion: "success",
    output: "report",
    turnsUsed: 4,
    providerRetries: 0,
    durationSeconds: 470.6,
    costUsd: 0.01,
    usage: { inputTokens: 1000, outputTokens: 100, estimated: false, modelLabel, source: "provider" },
    ...overrides,
  };
}
const fail = (modelLabel: string, failureClass: PiFailureClass) =>
  piResult(modelLabel, { conclusion: "failure", output: `failed: ${failureClass}`, failureClass });

function recorder(results: PiRunResult[]) {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    runAttempt: async (job: ReviewJob) => {
      seen.push(job.model.label);
      return results[Math.min(i++, results.length - 1)];
    },
  };
}

/** Four healthy lenses, as on #4710, plus the audit lane's decisive run. */
function councilRuns(audit: PiRunResult, auditModel: string): CouncilPolicyRun[] {
  const lens = (id: string): CouncilPolicyRun => ({
    role: "reviewer",
    lensId: id,
    modelLabel: MIMO.label,
    conclusion: "success",
  });
  return [
    lens("risk"),
    lens("tests"),
    lens("security"),
    lens("contracts"),
    { role: "validator-review", lensId: auditJob.lens.id, modelLabel: auditModel, conclusion: audit.conclusion },
  ];
}

async function runAudit(results: PiRunResult[], pinned: ModelSpec | undefined) {
  const rec = recorder(results);
  const out = await executeLensWithRetry({
    job: auditJob,
    roster: ROSTER,
    validatorReviewFailoverModel: pinned,
    deps: { runAttempt: rec.runAttempt },
  });
  const policy = evaluateCouncilPolicy({
    runs: councilRuns(out.lensResult, out.activeJob.model.label),
    configuredMaxDegradedLenses: 1,
  });
  return { rec, out, policy };
}

describe("validator-review invalid_output failover (EHAC-2522)", () => {
  it("fails over exactly once, to the PINNED model, and the council stays healthy", async () => {
    const { rec, out, policy } = await runAudit(
      [fail(ADVISOR.label, "invalid_output"), piResult(PINNED.label)],
      PINNED,
    );

    expect(rec.seen).toEqual([ADVISOR.label, PINNED.label]);
    expect(out.retried).toBe(true);
    expect(out.failoverUsed).toBe(true);
    expect(out.activeJob.role).toBe("validator-review");
    expect(out.attemptMetrics.map((m) => [m.assignedModel, m.actualModel, m.failover])).toEqual([
      [ADVISOR.label, ADVISOR.label, false],
      [ADVISOR.label, PINNED.label, true],
    ]);
    expect(policy.status).toBe("healthy");
  });

  it("a SECOND invalid_output breaches — there is no third attempt", async () => {
    const { rec, out, policy } = await runAudit(
      [fail(ADVISOR.label, "invalid_output"), fail(PINNED.label, "invalid_output"), piResult(MIMO.label)],
      PINNED,
    );

    expect(rec.seen).toEqual([ADVISOR.label, PINNED.label]);
    expect(out.lensResult.conclusion).toBe("failure");
    expect(policy.status).toBe("breached");
    expect(policy.failedValidatorRoleIds).toEqual(["validator-self-review"]);
    // And the decision itself refuses a third attempt even when asked directly.
    const third = resolveLensRetry({
      role: "validator-review",
      conclusion: "failure",
      failureClass: "invalid_output",
      attemptsSoFar: 2,
      assignedModel: ADVISOR,
      roster: ROSTER,
      validatorReviewFailoverModel: PINNED,
    });
    expect(third.retry).toBe(false);
    expect(third.reason).toContain("exhausted");
  });

  it.each(["timeout", "stall", "max_turns"] as const)(
    "does NOT fail over on %s, even with a pinned model",
    async (failureClass) => {
      const { rec, out, policy } = await runAudit([fail(ADVISOR.label, failureClass), piResult(PINNED.label)], PINNED);

      expect(rec.seen).toEqual([ADVISOR.label]);
      expect(out.retried).toBe(false);
      expect(policy.status).toBe("breached");
    },
  );

  it("refuses a pinned model with the SAME identity as the one that failed", async () => {
    const sameModelOtherRoute: ModelSpec = {
      provider: "deepseek",
      model: "deepseek/deepseek-v4-pro-0813",
      label: "deepseek/deepseek-v4-pro-0813",
    };
    const { rec, policy } = await runAudit(
      [fail(ADVISOR.label, "invalid_output"), piResult(sameModelOtherRoute.label)],
      sameModelOtherRoute,
    );

    expect(rec.seen).toEqual([ADVISOR.label]);
    expect(policy.status).toBe("breached");
  });

  it("keeps the 404 failover on the ROSTER, untouched by the pinned model", async () => {
    const { rec } = await runAudit([fail(ADVISOR.label, "provider_unavailable"), piResult(MIMO.label)], PINNED);
    expect(rec.seen).toEqual([ADVISOR.label, MIMO.label]);
  });

  it("an EMPTY config is today's behaviour byte for byte: one attempt, the same decision, the same policy outcome", async () => {
    const { rec, out, policy } = await runAudit(
      [fail(ADVISOR.label, "invalid_output"), piResult(PINNED.label)],
      resolveValidatorReviewFailoverModel({ provider: "deepseek", model: "", validatorReviewFailoverModel: "  " }),
    );

    expect(rec.seen).toEqual([ADVISOR.label]);
    expect(out.retried).toBe(false);
    expect(out.attemptMetrics).toHaveLength(1);
    // The literal pre-EHAC-2522 policy result for this council. Any drift in the
    // unconfigured path — a status, a census string, a field — turns this red.
    expect(JSON.stringify(policy)).toBe(
      JSON.stringify({
        configuredMaxDegradedLenses: 1,
        effectiveMaxDegradedLenses: 1,
        reviewerLensesTotal: 4,
        reviewerLensesFailed: 0,
        failedReviewerLensIds: [],
        failedValidatorRoleIds: ["validator-self-review"],
        unclassifiedRunLabels: [],
        warnings: [],
        status: "breached",
        message:
          "1 of 5 council model run(s) did not succeed: validator-self-review " +
          "(openrouter/deepseek/deepseek-v4-pro-0813 -> failure). A validator role did not succeed, " +
          "so nothing independently audited or reconciled the lens findings.",
      }),
    );
    expect(
      JSON.stringify(
        resolveLensRetry({
          role: "validator-review",
          conclusion: "failure",
          failureClass: "invalid_output",
          attemptsSoFar: 1,
          assignedModel: ADVISOR,
          roster: ROSTER,
        }),
      ),
    ).toBe(
      JSON.stringify({
        retry: false,
        failover: false,
        reason:
          "validator-review retries only on provider_unavailable; every other failure class is blocking either way",
      }),
    );
  });

  it("never resolves an absent or blank failover input to the primary model", () => {
    const inputs = { provider: "deepseek", model: "deepseek/deepseek-v4-pro" };
    expect(resolveValidatorReviewFailoverModel(inputs)).toBeUndefined();
    expect(resolveValidatorReviewFailoverModel({ ...inputs, validatorReviewFailoverModel: "" })).toBeUndefined();
    expect(resolveValidatorReviewFailoverModel({ ...inputs, validatorReviewFailoverModel: "openai/gpt-5.5" })?.label).toBe(
      "openai/gpt-5.5",
    );
  });
});

describe("parseValidatorReviewFailoverModelInput", () => {
  it("treats empty as the shipped default (no failover)", () => {
    expect(parseValidatorReviewFailoverModelInput("")).toBeUndefined();
    expect(parseValidatorReviewFailoverModelInput("   ")).toBeUndefined();
  });

  it("accepts one model spec", () => {
    expect(parseValidatorReviewFailoverModelInput(" openai/gpt-5.5 ")).toBe("openai/gpt-5.5");
  });

  it.each(["openai/gpt-5.5,xiaomi/mimo-v2.5-pro", "openai/gpt-5.5 xiaomi/mimo-v2.5-pro"])(
    "refuses a list (%p), naming the input",
    (bad) => {
      expect(() => parseValidatorReviewFailoverModelInput(bad)).toThrow(/validator_review_failover_model/);
    },
  );
});

describe("serial budget counts the validator-review failover (EHAC-2522)", () => {
  it("demands setup + 3R when the failover is pinned and the validator budget is unset", () => {
    // 37 + 2*600 = 1237 fits 30 min; 37 + 3*600 = 1837 does not.
    expect(assessSerialBudget({ runTimeoutSeconds: 600, jobTimeoutMinutes: 30 }).outcome).toBe("pass");
    const counted = assessSerialBudget({
      runTimeoutSeconds: 600,
      jobTimeoutMinutes: 30,
      validatorReviewFailoverConfigured: true,
    });
    expect(counted.outcome).toBe("fail");
    expect(counted.message).toContain("= 1837s");
    expect(counted.message).toContain("validator_review_failover_model is set");
  });

  it("keeps the retry-aware bound when the validator budget is already set", () => {
    const base = { runTimeoutSeconds: 600, validatorRunTimeoutSeconds: 900, jobTimeoutMinutes: 60 };
    // 37 + max(1200, 1800) + 900 = 2737 either way: that formula already counts 2V.
    expect(assessSerialBudget(base).message).toContain("= 2737s");
    expect(assessSerialBudget({ ...base, validatorReviewFailoverConfigured: true }).message).toContain("= 2737s");
  });

  it("leaves the unconfigured message untouched", () => {
    const off = assessSerialBudget({ runTimeoutSeconds: 600, jobTimeoutMinutes: 30 });
    const explicitOff = assessSerialBudget({
      runTimeoutSeconds: 600,
      jobTimeoutMinutes: 30,
      validatorReviewFailoverConfigured: false,
    });
    expect(explicitOff).toEqual(off);
    expect(off.message).toBe("Serial wall-clock budget checked: 37 + 2 x 600 = 1237s <= 30 x 60 = 1800s.");
  });
});

describe("orchestrator wiring (EHAC-2522)", () => {
  const run = readFileSync(join(import.meta.dir, "..", "src", "entrypoints", "run.ts"), "utf-8");

  it("hands the pinned model to the lens executor and tells the budget guard it is set", () => {
    expect(run).toMatch(/executeLensWithRetry\(\{[^}]*validatorReviewFailoverModel,/s);
    expect(run).toMatch(
      /assessSerialBudget\(\{[^}]*validatorReviewFailoverConfigured:\s*parsedInputs\.validatorReviewFailoverModel !== undefined/s,
    );
    expect(run).toContain("resolveValidatorReviewFailoverModel(inputs)");
  });
});
