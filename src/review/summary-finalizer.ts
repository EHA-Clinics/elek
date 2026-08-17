/**
 * ONE idempotent place that emits `review_summary_json`.
 *
 * The defect this exists for: a required reviewer lens that exhausted its retry
 * made elek `throw`, the throw escaped `run()`, and the action exited WITHOUT
 * ever setting `review_summary_json`. The downstream coverage producer then
 * recorded zero model runs and the gate failed closed on U5 — "no evidence a
 * review prompt was ever built" — for a review that had in fact produced five
 * healthy lens reports. Measured on four eha_care pull requests at once.
 *
 * The quorum that was supposed to tolerate a single dropout was made MOOT by
 * this: it tolerates a RECORDED failed run, and there was no record to tolerate.
 *
 * So every supported terminal path funnels through `finalize()`, and it emits at
 * most once. Emitting twice would be its own defect — the second write would
 * overwrite the first with whatever partial state existed at the later call site.
 */
import * as core from "@actions/core";
import { writeFileSync } from "fs";
import { join } from "path";

import { buildReviewSummary, type ReviewSummaryInput } from "./summary.js";

/** Which supported terminal path produced the summary. */
export type SummaryTerminalReason =
  | "completed"
  | "declined"
  | "council_policy_breached"
  | "validator_failed"
  | "configuration_error"
  | "unexpected_error";

export interface SummaryFinalizer {
  /** Merge accumulated state. Safe to call repeatedly as the run progresses. */
  update(patch: Partial<ReviewSummaryInput>): void;
  /** True once a summary has been emitted. */
  emitted(): boolean;
  /**
   * Emit exactly once. Returns true if THIS call performed the write.
   *
   * Returns false — without throwing — when a summary was already emitted, so a
   * top-level handler can call this unconditionally without having to know
   * whether the normal path already ran.
   */
  finalize(args: {
    conclusion: "success" | "failure";
    terminalReason: SummaryTerminalReason;
    failureMessage?: string;
    skipReason?: string;
  }): boolean;
}

export function createSummaryFinalizer(seed: Partial<ReviewSummaryInput> & {
  tmpDir: string;
}): SummaryFinalizer {
  let state: Partial<ReviewSummaryInput> = { ...seed };
  let done = false;

  return {
    update(patch) {
      state = { ...state, ...patch };
    },
    emitted() {
      return done;
    },
    finalize({ conclusion, terminalReason, failureMessage, skipReason }) {
      if (done) return false;
      // Without a parsed context there is no entity to describe, and inventing
      // one would be a false claim about what was reviewed. The unsupported-event
      // path stays a plain failure with no summary at all.
      if (!state.context) {
        console.warn(
          "[summary] no GitHub context is available, so no review summary can honestly be emitted.",
        );
        return false;
      }
      done = true;

      const finishedAt = new Date();
      const summary = buildReviewSummary({
        context: state.context,
        runId: state.runId ?? process.env.GITHUB_RUN_ID ?? "?",
        jobRunLink: state.jobRunLink ?? "",
        conclusion,
        mode: state.mode ?? "review",
        requestedStrategy: state.requestedStrategy ?? "",
        executedStrategy: state.executedStrategy ?? "solo",
        primaryModelLabel: state.primaryModelLabel ?? "",
        finalModelLabel: state.finalModelLabel ?? state.primaryModelLabel ?? "",
        startedAt: state.startedAt ?? finishedAt,
        finishedAt,
        commentId: state.commentId,
        branchName: state.branchName,
        inlineComments: state.inlineComments ?? { posted: 0, skipped: 0, failed: 0 },
        costTotal:
          state.costTotal ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, estimated: true, runs: [] },
        runs: state.runs ?? [],
        findings: state.findings ?? [],
        promptBudgets: state.promptBudgets ?? [],
        retriedLensIds: state.retriedLensIds ?? [],
        attempts: state.attempts ?? [],
        councilPolicy: state.councilPolicy,
        terminalReason,
        ...(skipReason ? { skipReason } : {}),
        ...(failureMessage ? { failureMessage } : {}),
      });

      const json = JSON.stringify(summary);
      const pretty = JSON.stringify(summary, null, 2);
      const path = join(seed.tmpDir, "elek-review-summary.json");
      try {
        writeFileSync(path, `${pretty}\n`, "utf-8");
        core.setOutput("review_summary_path", path);
        console.log(`Wrote review summary: ${path} (terminal_reason=${terminalReason})`);
      } catch (err) {
        console.warn("Could not write review summary file:", (err as Error).message);
        core.setOutput("review_summary_path", "");
      }
      // The JSON output is the load-bearing one: the coverage producer reads it,
      // not the file. It is set even when the file write fails.
      core.setOutput("review_summary_json", json);
      return true;
    },
  };
}
