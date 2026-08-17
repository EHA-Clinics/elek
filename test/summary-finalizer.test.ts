/**
 * The summary finalizer — emit exactly once, on every supported terminal path.
 *
 * Outputs are asserted through the REAL @actions/core file-command channel
 * (GITHUB_OUTPUT), not a mock, so "the action set review_summary_json" is what is
 * actually being checked rather than "a stub was called".
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createSummaryFinalizer } from "../src/review/summary-finalizer";
import type { GitHubEntityContext } from "../src/types";

let dir: string;
let outputFile: string;
const savedOutput = process.env.GITHUB_OUTPUT;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elek-finalizer-"));
  outputFile = join(dir, "gh-output");
  require("fs").writeFileSync(outputFile, "", "utf-8");
  process.env.GITHUB_OUTPUT = outputFile;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedOutput === undefined) delete process.env.GITHUB_OUTPUT;
  else process.env.GITHUB_OUTPUT = savedOutput;
});

const context: GitHubEntityContext = {
  eventName: "pull_request",
  eventAction: "opened",
  actor: "someone",
  repo: { owner: "EHA-Clinics", repo: "eha_care", fullName: "EHA-Clinics/eha_care", defaultBranch: "v2" },
  entityNumber: 3680,
  isPR: true,
  triggerText: "",
  pr: { title: "t", body: "b", headRef: "h", baseRef: "v2", headSha: "abc", baseSha: "def" },
};

/** Parse @actions/core's heredoc file-command format back into {name: value}. */
function readOutputs(): Record<string, string[]> {
  const raw = readFileSync(outputFile, "utf-8");
  const out: Record<string, string[]> = {};
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    if (!match) continue;
    const [, name, delimiter] = match;
    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== delimiter) body.push(lines[i++]);
    (out[name] ??= []).push(body.join("\n"));
  }
  return out;
}

const finalizerFor = () =>
  createSummaryFinalizer({
    tmpDir: dir,
    context,
    runId: "42",
    jobRunLink: "https://example.invalid/run/42",
    startedAt: new Date("2026-08-18T00:00:00Z"),
  });

describe("createSummaryFinalizer", () => {
  it("emits review_summary_json and writes the file on a completed run", () => {
    const finalizer = finalizerFor();
    finalizer.update({ executedStrategy: "council", primaryModelLabel: "m", runs: [] });
    expect(finalizer.finalize({ conclusion: "success", terminalReason: "completed" })).toBe(true);

    const outputs = readOutputs();
    expect(outputs.review_summary_json).toHaveLength(1);
    const summary = JSON.parse(outputs.review_summary_json[0]);
    expect(summary.run.conclusion).toBe("success");
    expect(summary.review.terminalReason).toBe("completed");
    expect(summary.entity.number).toBe(3680);
    expect(existsSync(outputs.review_summary_path[0])).toBe(true);
  });

  it("emits AT MOST ONE summary, however many terminal paths fire", () => {
    // The top-level handler calls finalize() unconditionally. A second write
    // would overwrite the real record with whatever partial state existed later.
    const finalizer = finalizerFor();
    expect(finalizer.finalize({ conclusion: "success", terminalReason: "completed" })).toBe(true);
    expect(finalizer.finalize({ conclusion: "failure", terminalReason: "unexpected_error", failureMessage: "boom" })).toBe(false);
    expect(finalizer.finalize({ conclusion: "failure", terminalReason: "validator_failed" })).toBe(false);

    const outputs = readOutputs();
    expect(outputs.review_summary_json).toHaveLength(1);
    expect(JSON.parse(outputs.review_summary_json[0]).run.conclusion).toBe("success");
    expect(finalizer.emitted()).toBe(true);
  });

  it("emits a FAILURE summary carrying the runs that did complete", () => {
    // The D3 defect in one assertion: a breached council must still publish the
    // lens reports it produced, or the downstream gate reports "no evidence a
    // review prompt was ever built" for a review that mostly worked.
    const finalizer = finalizerFor();
    finalizer.update({
      executedStrategy: "council",
      runs: [
        { role: "reviewer", lensId: "risk", modelLabel: "a", conclusion: "success", turnsUsed: 3, providerRetries: 0, durationSeconds: 10, inputTokens: 100, outputTokens: 10, costUsd: 0.01, costEstimated: false, pricingSource: "provider" },
        { role: "reviewer", lensId: "tests", modelLabel: "b", conclusion: "failure", failureClass: "stall", turnsUsed: 1, providerRetries: 0, durationSeconds: 120, inputTokens: 100, outputTokens: 0, costUsd: 0.01, costEstimated: false, pricingSource: "provider" },
      ],
      costTotal: { costUsd: 0.02, inputTokens: 200, outputTokens: 10, estimated: false, runs: [] },
    });
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "council_policy_breached",
      failureMessage: "Council policy breached: two lenses down",
    });

    const summary = JSON.parse(readOutputs().review_summary_json[0]);
    expect(summary.run.conclusion).toBe("failure");
    expect(summary.review.terminalReason).toBe("council_policy_breached");
    expect(summary.review.failureMessage).toContain("two lenses down");
    expect(summary.modelRuns).toHaveLength(2);
    expect(summary.modelRuns[1].failureClass).toBe("stall");
  });

  it("emits a zero-run summary for an explicit decline, with the reason named", () => {
    const finalizer = finalizerFor();
    finalizer.finalize({ conclusion: "success", terminalReason: "declined", skipReason: "no_trigger_detected" });

    const summary = JSON.parse(readOutputs().review_summary_json[0]);
    expect(summary.modelRuns).toEqual([]);
    expect(summary.review.skipReason).toBe("no_trigger_detected");
    expect(summary.review.terminalReason).toBe("declined");
    expect(summary.run.conclusion).toBe("success");
  });

  it("does not label a zero-run FAILURE as a decline", () => {
    // Zero runs plus any reason other than an explicit decline is a failure, and
    // the record has to say so — otherwise a review that died before it started
    // is indistinguishable from one that was never requested.
    const finalizer = finalizerFor();
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "configuration_error",
      failureMessage: "GITHUB_TOKEN not available",
    });

    const summary = JSON.parse(readOutputs().review_summary_json[0]);
    expect(summary.modelRuns).toEqual([]);
    expect(summary.review.skipReason).toBe("");
    expect(summary.review.terminalReason).toBe("configuration_error");
    expect(summary.run.conclusion).toBe("failure");
  });

  it("carries the applied council policy so a downstream gate can detect drift", () => {
    const finalizer = finalizerFor();
    finalizer.update({
      councilPolicy: {
        status: "degraded",
        configuredMaxDegradedLenses: 1,
        effectiveMaxDegradedLenses: 1,
        reviewerLensesTotal: 4,
        reviewerLensesFailed: 1,
        failedReviewerLensIds: ["tests"],
        failedValidatorRoleIds: [],
        unclassifiedRunLabels: [],
        message: "degraded",
        warnings: [],
      },
    });
    finalizer.finalize({ conclusion: "success", terminalReason: "completed" });

    const summary = JSON.parse(readOutputs().review_summary_json[0]);
    expect(summary.councilPolicy.effectiveMaxDegradedLenses).toBe(1);
    expect(summary.councilPolicy.status).toBe("degraded");
  });

  it("makes no false claim when there is no context to describe", () => {
    const finalizer = createSummaryFinalizer({ tmpDir: dir });
    expect(finalizer.finalize({ conclusion: "failure", terminalReason: "unexpected_error" })).toBe(false);
    expect(readOutputs().review_summary_json).toBeUndefined();
  });

  it("still sets review_summary_json when the summary FILE cannot be written", () => {
    // The producer reads the JSON output, not the file. Losing the file must not
    // lose the record.
    const finalizer = createSummaryFinalizer({
      tmpDir: join(dir, "does", "not", "exist"),
      context,
      startedAt: new Date("2026-08-18T00:00:00Z"),
    });
    expect(finalizer.finalize({ conclusion: "success", terminalReason: "completed" })).toBe(true);

    const outputs = readOutputs();
    expect(outputs.review_summary_json).toHaveLength(1);
    expect(outputs.review_summary_path[0]).toBe("");
  });
});
