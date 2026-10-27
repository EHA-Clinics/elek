/**
 * One logical reviewer lens, executed with at most ONE elek-managed outer retry.
 *
 * Extracted from `src/entrypoints/run.ts` so the retry contract is testable
 * without a GitHub event, an octokit, or a real pi. The properties that matter
 * here — one retry and never two, a rebuilt prompt on failover, both attempts
 * charged, one DECISIVE logical run — are exactly the ones that were previously
 * only observable by reading a 900-line entrypoint and trusting it.
 *
 * The pi invocation is injected. That is what makes "the prompt was rebuilt for
 * the replacement model" a checkable claim: the caller builds the prompt FROM the
 * job it is handed, so a test can assert which model each attempt was given.
 */
import type { PiRunResult } from "../types.js";
import type { DiffPromptBudgetReport, ModelSpec, ReviewJob } from "./strategy.js";
import { resolveLensRetry } from "./strategy.js";
import type { TimeoutRetryBudgetInput } from "./serial-budget.js";
import type { ReviewAttemptMetric, ReviewRunRole } from "./summary.js";

/** Per-attempt overrides the executor hands to `runAttempt`. */
export interface LensAttemptOverrides {
  /** A shorter wall clock for a `timeout` retry (ruling 4). Absent: the role's normal budget. */
  runTimeoutSeconds?: number;
}

export interface LensExecutionDeps {
  /**
   * Run one attempt. The caller MUST build the prompt and the pi inputs from the
   * `job` it receives, not from the lens's originally-assigned job — that is how
   * a model substitution gets the replacement model's prompt label and its diff
   * budget instead of the failed model's.
   */
  runAttempt: (job: ReviewJob, promptName: string, overrides?: LensAttemptOverrides) => Promise<PiRunResult>;
  /**
   * The job's wall-clock state, read from the live clock when an attempt has failed
   * (ruling 4). Without it a `timeout` is never retried, because no budget can be proven.
   */
  timeoutRetryBudget?: () => TimeoutRetryBudgetInput;
  /** The budget report the packer produced for THIS job's prompt, if any. */
  promptBudgetFor?: (job: ReviewJob) => DiffPromptBudgetReport | undefined;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface LensExecutionResult {
  /** The lens as planned, including its originally-assigned model. */
  job: ReviewJob;
  /** The job the DECISIVE attempt ran, which differs from `job` after a failover. */
  activeJob: ReviewJob;
  /** The decisive attempt's result. */
  lensResult: PiRunResult;
  /** Every physical attempt, in order. */
  attempts: PiRunResult[];
  attemptMetrics: ReviewAttemptMetric[];
  retried: boolean;
  failoverUsed: boolean;
}

function attemptMetric(params: {
  job: ReviewJob;
  usedJob: ReviewJob;
  attempt: number;
  failover: boolean;
  result: PiRunResult;
  promptBudget?: DiffPromptBudgetReport;
  runTimeoutSeconds?: number;
}): ReviewAttemptMetric {
  const { job, usedJob, result } = params;
  return {
    lensId: job.lens.id,
    lensTitle: job.lens.title,
    role: (job.role || "reviewer") as ReviewRunRole,
    attempt: params.attempt,
    assignedModel: job.model.label,
    actualModel: usedJob.model.label,
    failover: params.failover,
    conclusion: result.conclusion,
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(result.providerHttpStatus !== undefined
      ? { providerHttpStatus: result.providerHttpStatus }
      : {}),
    ...(result.providerIneligibilityReasons
      ? { providerIneligibilityReasons: result.providerIneligibilityReasons }
      : {}),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    durationSeconds: roundSeconds(result.durationSeconds),
    turnsUsed: result.turnsUsed,
    providerRetries: result.providerRetries,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: roundUsd(result.costUsd),
    timeToFirstEventSeconds: result.timeToFirstEventSeconds ?? null,
    maxIdleSecondsObserved: result.maxIdleSecondsObserved ?? 0,
    streamEventCount: result.streamEventCount ?? 0,
    malformedLineCount: result.malformedLineCount ?? 0,
    ...(result.lastEventType ? { lastEventType: result.lastEventType } : {}),
    ...(params.promptBudget ? { promptBudget: params.promptBudget } : {}),
    // Additive, and only on an attempt that ran on an overridden (shorter) budget.
    ...(params.runTimeoutSeconds !== undefined ? { runTimeoutSeconds: params.runTimeoutSeconds } : {}),
  };
}

/**
 * A lens that could not use its tools has not verified anything.
 *
 * Measured on eha-care-infra #1373 (council run 40581571656): the tests lens's
 * tool access failed, it produced no verifiable findings, and the council still
 * reported COMPLETE/SUCCESS with zero findings — a degraded lens counted as a
 * clean pass. Every tool call in that run ended with isError, which elek already
 * sees on the stream; it just never reached the verdict.
 *
 * The rule is narrow on purpose: it fires only when calls > 0 and ALL of them
 * errored. A run with NO tool calls is left alone, because the review prompt
 * explicitly allows a self-contained change to need none (pi.ts:46).
 */
function applyToolAccessVerdict(result: PiRunResult): PiRunResult {
  const calls = result.toolCalls ?? 0;
  const successes = result.toolSuccesses ?? 0;
  if (result.conclusion === "success" && calls > 0 && successes === 0) {
    return {
      ...result,
      conclusion: "failure",
      failureClass: "tool_access",
      output:
        `${result.output}\n\n[eval] no tool call in this run succeeded (${calls} started, ` +
        `${result.toolErrors ?? 0} errored, ${calls - successes - (result.toolErrors ?? 0)} unclosed); ` +
        "a review with no tool evidence is not a clean pass.",
    };
  }
  return result;
}

export async function executeLensWithRetry(params: {
  job: ReviewJob;
  /** Reviewer models a failover may move to. Excludes the advisor by construction. */
  roster: readonly ModelSpec[];
  /** Pinned validator-review failover for `invalid_output` (EHAC-2522) and `max_turns` (EHAC-3644) only. */
  validatorReviewFailoverModel?: ModelSpec;
  deps: LensExecutionDeps;
}): Promise<LensExecutionResult> {
  const { job, roster, deps } = params;
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? (() => {});
  const attempts: PiRunResult[] = [];
  const attemptMetrics: ReviewAttemptMetric[] = [];
  let activeJob: ReviewJob = job;
  let failoverUsed = false;
  let retried = false;

  const record = (result: PiRunResult, usedJob: ReviewJob, failover: boolean, runTimeoutSeconds?: number) => {
    attempts.push(result);
    attemptMetrics.push(
      attemptMetric({
        job,
        usedJob,
        attempt: attempts.length,
        failover,
        result,
        promptBudget: deps.promptBudgetFor?.(usedJob),
        runTimeoutSeconds,
      }),
    );
  };

  let lensResult = applyToolAccessVerdict(await deps.runAttempt(activeJob, `lens-${job.lens.id}`));
  record(lensResult, activeJob, false);

  const decision = resolveLensRetry({
    role: job.role,
    conclusion: lensResult.conclusion,
    failureClass: lensResult.failureClass,
    attemptsSoFar: attempts.length,
    assignedModel: job.model,
    roster,
    validatorReviewFailoverModel: params.validatorReviewFailoverModel,
    // Read from the live clock only when the attempt timed out.
    timeoutBudget: lensResult.failureClass === "timeout" ? deps.timeoutRetryBudget?.() : undefined,
  });

  if (lensResult.conclusion === "failure" && !decision.retry) {
    warn(
      `[${job.lens.id}] attempt 1 failed (class=${lensResult.failureClass ?? "unclassified"}) ` +
        `and is NOT retried: ${decision.reason}`,
    );
  }

  if (decision.retry && decision.model) {
    retried = true;
    failoverUsed = decision.failover;
    // A substitution builds a REPLACEMENT ReviewJob. The prompt names the reviewer
    // model and the diff budget is derived from that model's context capacity, so
    // reusing the first attempt's prompt would misattribute the review and report
    // a budget the replacement never had.
    activeJob = decision.failover ? { ...job, model: decision.model } : job;
    warn(
      `[${job.lens.id}] attempt 1 failed (class=${lensResult.failureClass ?? "unclassified"}) — ${decision.reason}`,
    );
    const overrides: LensAttemptOverrides | undefined =
      decision.runTimeoutSeconds !== undefined ? { runTimeoutSeconds: decision.runTimeoutSeconds } : undefined;
    const retryResult = applyToolAccessVerdict(await deps.runAttempt(activeJob, `lens-${job.lens.id}-retry`, overrides));
    record(retryResult, activeJob, decision.failover, overrides?.runTimeoutSeconds);
    log(
      retryResult.conclusion === "success"
        ? `[${job.lens.id}] retry succeeded on ${activeJob.model.label}`
        : `[${job.lens.id}] retry also failed on ${activeJob.model.label} ` +
          `(class=${retryResult.failureClass ?? "unclassified"})`,
    );
    lensResult = retryResult;
  }

  return { job, activeJob, lensResult, attempts, attemptMetrics, retried, failoverUsed };
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function roundUsd(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}
