import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInputs } from "../src/github/context";
import { executeLensWithRetry } from "../src/review/lens-execution";
import { persistReviewReport } from "../src/review/report-artifact";
import { parseReviewLensList, resolveReviewPlan } from "../src/review/strategy";
import type { PiFailureClass, PiRunResult } from "../src/types";

const inputs = {
  ...parseInputs(),
  provider: "openrouter",
  reviewStrategy: "council",
  reviewModels: "openrouter/z-ai/glm-5.3-flash,xiaomi/mimo-v2.5-pro,openrouter/deepseek/deepseek-v4.1-flash",
  validatorModel: "openrouter/deepseek/deepseek-v4-pro-0813",
  advisorModel: "",
  reviewLenses: "",
};

describe("council attempt report names", () => {
  for (const failure of [undefined, "provider_transient", "stall", "provider_unavailable"] as const) {
    it(`persists every concurrent attempt and final report: ${failure ?? "first-attempt success"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "elek-report-names-"));
      try {
        const plan = resolveReviewPlan(inputs);
        const jobs = [...plan.jobs, ...(plan.validatorReview ? [plan.validatorReview] : [])];
        expect(jobs).toHaveLength(5);
        const names: string[] = [];
        const results = await Promise.all(jobs.map((job) => {
          let attempt = 0;
          return executeLensWithRetry({ job, roster: plan.jobs.map((j) => j.model), deps: {
            runAttempt: async (active, name) => {
              attempt++;
              const failed = failure !== undefined && attempt === 1;
              const result: PiRunResult = {
                conclusion: failed ? "failure" : "success",
                output: `${name}: ${active.model.label}`,
                turnsUsed: 1, providerRetries: 0, durationSeconds: 0, costUsd: 0,
                usage: { inputTokens: 0, outputTokens: 0, estimated: true, modelLabel: active.model.label, source: "unknown" },
                ...(failed ? { failureClass: failure as PiFailureClass } : {}),
                ...(failed && failure === "provider_unavailable" ? { providerHttpStatus: 404 } : {}),
              };
              // Use exactly the unsanitized name handed to run.ts, including retries.
              persistReviewReport(root, name, { modelLabel: active.model.label, conclusion: result.conclusion, output: result.output });
              names.push(name);
              expect(JSON.parse(readFileSync(join(root, "elek-reports", `${name}.json`), "utf8")).output).toBe(result.output);
              return result;
            },
          } });
        }));
        persistReviewReport(root, "validator-final", { modelLabel: plan.validator.label, conclusion: "success", output: "final" });
        names.push("validator-final");
        expect(names.every((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))).toBe(true);
        expect(new Set(names).size).toBe(names.length);
        expect(readdirSync(join(root, "elek-reports")).sort()).toEqual(names.map((n) => `${n}.json`).sort());
        // Validator self-review retries only provider-unavailable, unlike reviewer lanes.
        const expectedAttempts = failure === undefined ? 5 : failure === "provider_unavailable" ? 10 : 9;
        expect(results.reduce((sum, r) => sum + r.attempts.length, 0)).toBe(expectedAttempts);
        if (failure === "provider_transient") {
          expect(results.filter((r) => r.job.role === "reviewer").every((r) => r.retried && !r.failoverUsed)).toBe(true);
          expect(results.find((r) => r.job.role === "validator-review")?.retried).toBe(false);
        }
        if (failure === "provider_unavailable") expect(results.every((r) => r.retried && r.failoverUsed)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("catalog and generated lenses cannot collide with retry or final report names", () => {
    expect(parseReviewLensList("risk,risk,operations").map((l) => l.id)).toEqual(["risk", "operations"]);
    expect(() => parseReviewLensList("risk-retry")).toThrow("Unknown review_lenses");
    for (const reviewStrategy of ["crosscheck", "council", "thermos"]) {
      const plan = resolveReviewPlan({ ...inputs, reviewStrategy, reviewAgentCount: 8 });
      const jobs = [...plan.jobs, ...(plan.validatorReview ? [plan.validatorReview] : [])];
      const names = [...jobs.flatMap((j) => [`lens-${j.lens.id}`, `lens-${j.lens.id}-retry`]), "validator-final"];
      expect(names.every((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
