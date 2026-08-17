/**
 * executeLensWithRetry — the ONE elek-managed outer retry, end to end.
 *
 * pi is injected, so every assertion here is about the retry contract itself:
 * how many attempts happen, which model each one used, which prompt it was
 * built from, and which single attempt becomes the lens's decisive result.
 */
import { describe, expect, it } from "bun:test";
import { executeLensWithRetry } from "../src/review/lens-execution";
import type { ModelSpec, ReviewJob } from "../src/review/strategy";
import type { PiFailureClass, PiRunResult } from "../src/types";

const PRO: ModelSpec = { provider: "deepseek", model: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" };
const MIMO: ModelSpec = { provider: "xiaomi", model: "xiaomi/mimo-v2.5-pro", label: "xiaomi/mimo-v2.5-pro" };
const FLASH: ModelSpec = { provider: "deepseek", model: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash" };
const ROSTER = [PRO, MIMO, FLASH];

const job = (model: ModelSpec, role: ReviewJob["role"] = "reviewer"): ReviewJob => ({
  lens: { id: "tests", title: "Test Integrity Review", focus: "tests" },
  model,
  role,
});

function piResult(overrides: Partial<PiRunResult> & { modelLabel: string }): PiRunResult {
  const { modelLabel, ...rest } = overrides;
  return {
    conclusion: "success",
    output: "report",
    turnsUsed: 4,
    providerRetries: 0,
    durationSeconds: 12.34,
    costUsd: 0.01,
    usage: { inputTokens: 1000, outputTokens: 100, estimated: false, modelLabel, source: "provider" },
    ...rest,
  };
}

const fail = (modelLabel: string, failureClass: PiFailureClass): PiRunResult =>
  piResult({ modelLabel, conclusion: "failure", output: `failed: ${failureClass}`, failureClass });

/** Record which model each attempt was asked to run, in order. */
function recorder(results: PiRunResult[]) {
  const seen: Array<{ model: string; promptName: string }> = [];
  let i = 0;
  return {
    seen,
    runAttempt: async (activeJob: ReviewJob, promptName: string) => {
      seen.push({ model: activeJob.model.label, promptName });
      return results[Math.min(i++, results.length - 1)];
    },
  };
}

describe("executeLensWithRetry", () => {
  it("does not retry a lens that succeeded first time", async () => {
    const rec = recorder([piResult({ modelLabel: PRO.label })]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    expect(rec.seen).toHaveLength(1);
    expect(out.retried).toBe(false);
    expect(out.failoverUsed).toBe(false);
    expect(out.attempts).toHaveLength(1);
    expect(out.lensResult.conclusion).toBe("success");
  });

  it("rebuilds the attempt on the next distinct model after a stall", async () => {
    const rec = recorder([fail(PRO.label, "stall"), piResult({ modelLabel: MIMO.label })]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    // The SECOND attempt was handed a different job, which is what makes the
    // prompt name the replacement model and receive its diff budget.
    expect(rec.seen.map((s) => s.model)).toEqual([PRO.label, MIMO.label]);
    expect(rec.seen[1].promptName).toBe("lens-tests-retry");
    expect(out.failoverUsed).toBe(true);
    expect(out.activeJob.model.label).toBe(MIMO.label);
    // One SUCCESSFUL decisive logical run, under the replacement model.
    expect(out.lensResult.conclusion).toBe("success");
    expect(out.lensResult.usage.modelLabel).toBe(MIMO.label);
  });

  it("retries a transient provider fault on the same model", async () => {
    const rec = recorder([fail(PRO.label, "provider_transient"), piResult({ modelLabel: PRO.label })]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    expect(rec.seen.map((s) => s.model)).toEqual([PRO.label, PRO.label]);
    expect(out.failoverUsed).toBe(false);
    expect(out.retried).toBe(true);
  });

  it("charges and records BOTH attempts while reporting one decisive run", async () => {
    const rec = recorder([fail(PRO.label, "stall"), piResult({ modelLabel: MIMO.label, costUsd: 0.02 })]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    expect(out.attempts).toHaveLength(2);
    expect(out.attemptMetrics).toHaveLength(2);
    expect(out.attemptMetrics.map((a) => a.attempt)).toEqual([1, 2]);
    expect(out.attemptMetrics[0]).toMatchObject({
      lensId: "tests",
      role: "reviewer",
      assignedModel: PRO.label,
      actualModel: PRO.label,
      failover: false,
      conclusion: "failure",
      failureClass: "stall",
    });
    expect(out.attemptMetrics[1]).toMatchObject({
      assignedModel: PRO.label,
      actualModel: MIMO.label,
      failover: true,
      conclusion: "success",
    });
    // Cost is per attempt, so the pair is visible rather than averaged away.
    expect(out.attemptMetrics[0].costUsd + out.attemptMetrics[1].costUsd).toBeCloseTo(0.03, 6);
  });

  it("attaches the budget report of the model each attempt ACTUALLY ran", async () => {
    const rec = recorder([fail(PRO.label, "stall"), piResult({ modelLabel: MIMO.label })]);
    const out = await executeLensWithRetry({
      job: job(PRO),
      roster: ROSTER,
      deps: {
        runAttempt: rec.runAttempt,
        promptBudgetFor: (activeJob) => ({
          lensId: activeJob.lens.id,
          modelLabel: activeJob.model.label,
          reservedChars: 30_000,
          diffPromptBudgetChars: activeJob.model.label === MIMO.label ? 111_111 : 222_222,
          excludePaths: [],
        }),
      },
    });

    expect(out.attemptMetrics[0].promptBudget!.modelLabel).toBe(PRO.label);
    expect(out.attemptMetrics[0].promptBudget!.diffPromptBudgetChars).toBe(222_222);
    // Reusing attempt 1's prompt would report 222_222 here — the failed model's
    // budget — and misattribute the coverage the replacement actually received.
    expect(out.attemptMetrics[1].promptBudget!.modelLabel).toBe(MIMO.label);
    expect(out.attemptMetrics[1].promptBudget!.diffPromptBudgetChars).toBe(111_111);
  });

  it("produces ONE failed decisive logical run when failover is exhausted", async () => {
    const rec = recorder([fail(PRO.label, "stall"), fail(MIMO.label, "stall")]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    expect(rec.seen).toHaveLength(2);
    expect(out.attempts).toHaveLength(2);
    expect(out.lensResult.conclusion).toBe("failure");
    expect(out.lensResult.failureClass).toBe("stall");
    expect(out.activeJob.model.label).toBe(MIMO.label);
  });

  it("performs exactly ONE outer retry even when the second attempt is also retryable", async () => {
    const rec = recorder([fail(PRO.label, "stall"), fail(MIMO.label, "provider_transient")]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    // A third attempt here would blow the job-cap arithmetic that assumes
    // setup + 2 x run_timeout, so it must never happen.
    expect(rec.seen).toHaveLength(2);
    expect(out.attempts).toHaveLength(2);
  });

  it("does not retry an unclassified failure", async () => {
    const unclassified = piResult({ modelLabel: PRO.label, conclusion: "failure", output: "boom" });
    const rec = recorder([unclassified]);
    const out = await executeLensWithRetry({ job: job(PRO), roster: ROSTER, deps: { runAttempt: rec.runAttempt } });

    expect(rec.seen).toHaveLength(1);
    expect(out.retried).toBe(false);
  });

  it("does not retry the validator-review lane", async () => {
    const rec = recorder([fail(PRO.label, "stall")]);
    const out = await executeLensWithRetry({
      job: job(PRO, "validator-review"),
      roster: ROSTER,
      deps: { runAttempt: rec.runAttempt },
    });

    expect(rec.seen).toHaveLength(1);
    expect(out.retried).toBe(false);
    expect(out.attemptMetrics[0].role).toBe("validator-review");
  });

  it("fails closed after one attempt when a single-model roster offers no failover", async () => {
    const rec = recorder([fail(PRO.label, "stall")]);
    const warnings: string[] = [];
    const out = await executeLensWithRetry({
      job: job(PRO),
      roster: [PRO],
      deps: { runAttempt: rec.runAttempt, warn: (m) => warnings.push(m) },
    });

    expect(rec.seen).toHaveLength(1);
    expect(out.lensResult.conclusion).toBe("failure");
    expect(warnings.join(" ")).toContain("roster offers none");
  });

  it("does not treat a duplicate model spelling as a distinct failover target", async () => {
    const aliased: ModelSpec = {
      provider: "openrouter",
      model: "openrouter/deepseek/deepseek-v4-pro",
      label: "openrouter/deepseek/deepseek-v4-pro",
    };
    const rec = recorder([fail(PRO.label, "stall")]);
    const out = await executeLensWithRetry({
      job: job(PRO),
      roster: [PRO, aliased],
      deps: { runAttempt: rec.runAttempt },
    });

    expect(rec.seen).toHaveLength(1);
    expect(out.retried).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Structural: there is EXACTLY ONE elek-managed outer retry layer.
 *
 * The job-cap arithmetic downstream is `setup + 2 x run_timeout`. A second
 * retry layer stacked anywhere — a `for` loop around a lens, a retry inside
 * runPi, a wrapper around the validator — makes that arithmetic wrong by a whole
 * wall-clock budget and converts an honest red into a cancelled job with no
 * coverage record at all. Grepping the source is how that stays true after the
 * next change, because nothing about it is visible from a passing behaviour test.
 * ──────────────────────────────────────────────────────────────────────────── */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("retry layering", () => {
  const files = sourceFiles(join(import.meta.dir, "..", "src"));

  it("routes every retry decision through resolveLensRetry, from one module", () => {
    const callers = files.filter((f) => {
      const body = readFileSync(f, "utf-8");
      return /resolveLensRetry\s*\(/.test(body) && !f.endsWith("strategy.ts");
    });
    expect(callers.map((f) => f.split("/").pop())).toEqual(["lens-execution.ts"]);
  });

  it("invokes pi from exactly two call sites: the lens attempt and the un-retried validator", () => {
    const callSites = files.flatMap((f) => {
      const body = readFileSync(f, "utf-8");
      if (f.endsWith("/pi.ts")) return []; // the definition itself, not a call
      return [...body.matchAll(/\brunPi\s*\(/g)].map(() => f.split("/").pop()!);
    });
    // Both live in run.ts: one is handed to executeLensWithRetry as its
    // `runAttempt` dependency, the other is the final synthesis, which is not
    // retried at all. A third call site is a new retry surface by definition.
    expect(callSites).toEqual(["run.ts", "run.ts"]);
  });

  it("contains no loop-shaped retry around a lens attempt", () => {
    const execution = readFileSync(join(import.meta.dir, "..", "src", "review", "lens-execution.ts"), "utf-8");
    expect(execution).not.toMatch(/\b(for|while)\s*\(/);
    // Two literal runAttempt call sites: the initial attempt and the single retry.
    expect([...execution.matchAll(/deps\.runAttempt\(/g)]).toHaveLength(2);
  });
});
