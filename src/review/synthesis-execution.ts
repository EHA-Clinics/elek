/**
 * The FINAL validator (the synthesis), executed with at most ONE failover (EHAC-3622).
 *
 * Extracted from `src/entrypoints/run.ts` for the same reason as `lens-execution.ts`: the
 * contract (one failover and never two, only on stall or invalid_output, only on the
 * pinned model, only within the live job clock, both attempts recorded) is checkable
 * here without a GitHub event or a real pi.
 *
 * The retry re-runs the synthesis on the SAME lens reports. Lens work is never repeated:
 * keeping it is the whole point, since a failed synthesis used to discard every finished
 * lens report.
 */
import type { PiRunResult } from "../types.js";
import type { SynthesisRetryBudgetInput } from "./serial-budget.js";
import { resolveSynthesisRetry, type ModelSpec } from "./strategy.js";
import type { ReviewAttemptMetric } from "./summary.js";

/** Per-attempt overrides the executor hands to `runAttempt`. */
export interface SynthesisAttemptOverrides {
  /** The failover's wall clock, from the live job clock. Absent: the validator budget. */
  runTimeoutSeconds?: number;
}

export interface SynthesisExecutionDeps {
  /**
   * Run one synthesis attempt on `model`. The caller MUST build the prompt and the pi
   * inputs from the model it receives, so the failover gets its own prompt label.
   */
  runAttempt: (model: ModelSpec, promptName: string, overrides?: SynthesisAttemptOverrides) => Promise<PiRunResult>;
  /** The job's wall-clock state, read only after a failover-eligible failure. */
  retryBudget?: () => SynthesisRetryBudgetInput;
  /**
   * Called once, immediately before the failover attempt. The caller discards what the
   * failed attempt left behind (its buffered inline comments), so only the decisive
   * attempt's findings are posted.
   */
  beforeRetry?: () => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SynthesisExecutionResult {
  /** The model the DECISIVE attempt ran on. */
  activeModel: ModelSpec;
  /** The decisive attempt's result. */
  result: PiRunResult;
  /** Every physical attempt, in order. */
  attempts: PiRunResult[];
  attemptMetrics: ReviewAttemptMetric[];
  retried: boolean;
  failoverUsed: boolean;
}

/** The synthesis attempt record. The key order is the one run.ts emitted before EHAC-3622. */
function attemptMetric(params: {
  assigned: ModelSpec;
  used: ModelSpec;
  attempt: number;
  failover: boolean;
  result: PiRunResult;
  runTimeoutSeconds?: number;
}): ReviewAttemptMetric {
  const { result } = params;
  return {
    lensId: "validator",
    lensTitle: "Orchestrator synthesis",
    role: "validator",
    attempt: params.attempt,
    assignedModel: params.assigned.label,
    actualModel: result.usage.modelLabel || params.used.label,
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    failover: params.failover,
    conclusion: result.conclusion,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(result.providerHttpStatus !== undefined
      ? { providerHttpStatus: result.providerHttpStatus }
      : {}),
    ...(result.providerIneligibilityReasons
      ? { providerIneligibilityReasons: result.providerIneligibilityReasons }
      : {}),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    durationSeconds: Math.round(Math.max(0, result.durationSeconds) * 10) / 10,
    turnsUsed: result.turnsUsed,
    providerRetries: result.providerRetries,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: Math.round(Math.max(0, result.costUsd) * 1_000_000) / 1_000_000,
    timeToFirstEventSeconds: result.timeToFirstEventSeconds ?? null,
    maxIdleSecondsObserved: result.maxIdleSecondsObserved ?? 0,
    streamEventCount: result.streamEventCount ?? 0,
    malformedLineCount: result.malformedLineCount ?? 0,
    ...(result.lastEventType ? { lastEventType: result.lastEventType } : {}),
    // Additive, and only on the failover, whose budget comes from the live clock.
    ...(params.runTimeoutSeconds !== undefined ? { runTimeoutSeconds: params.runTimeoutSeconds } : {}),
  };
}

export async function executeSynthesisWithFailover(params: {
  /** The validator the synthesis is assigned to. */
  validator: ModelSpec;
  /** The pinned `validator_failover_model`; undefined keeps the synthesis a single attempt. */
  validatorFailoverModel?: ModelSpec;
  deps: SynthesisExecutionDeps;
}): Promise<SynthesisExecutionResult> {
  const { validator, deps } = params;
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? (() => {});
  const attempts: PiRunResult[] = [];
  const attemptMetrics: ReviewAttemptMetric[] = [];

  let result = await deps.runAttempt(validator, "prompt");
  attempts.push(result);
  attemptMetrics.push(attemptMetric({ assigned: validator, used: validator, attempt: 1, failover: false, result }));

  // Unconfigured: exactly the single attempt and the silence of the code before EHAC-3622.
  if (!params.validatorFailoverModel || result.conclusion !== "failure") {
    return { activeModel: validator, result, attempts, attemptMetrics, retried: false, failoverUsed: false };
  }

  const decision = resolveSynthesisRetry({
    conclusion: result.conclusion,
    failureClass: result.failureClass,
    attemptsSoFar: attempts.length,
    assignedModel: validator,
    validatorFailoverModel: params.validatorFailoverModel,
    // The live clock as attempt 1 ended, never an estimate of what the failure cost.
    budget: deps.retryBudget?.(),
  });
  const failed = `[validator] synthesis attempt 1 failed (class=${result.failureClass ?? "unclassified"})`;
  if (!decision.retry || !decision.model) {
    warn(`${failed} and is NOT retried: ${decision.reason}`);
    return { activeModel: validator, result, attempts, attemptMetrics, retried: false, failoverUsed: false };
  }

  const activeModel = decision.model;
  warn(`${failed} — ${decision.reason}`);
  deps.beforeRetry?.();
  const overrides: SynthesisAttemptOverrides | undefined =
    decision.runTimeoutSeconds !== undefined ? { runTimeoutSeconds: decision.runTimeoutSeconds } : undefined;
  result = await deps.runAttempt(activeModel, "prompt-failover", overrides);
  attempts.push(result);
  attemptMetrics.push(
    attemptMetric({
      assigned: validator,
      used: activeModel,
      attempt: 2,
      failover: true,
      result,
      runTimeoutSeconds: overrides?.runTimeoutSeconds,
    }),
  );
  log(
    result.conclusion === "success"
      ? `[validator] failover synthesis succeeded on ${activeModel.label}`
      : `[validator] failover synthesis also failed on ${activeModel.label} ` +
          `(class=${result.failureClass ?? "unclassified"})`,
  );
  return { activeModel, result, attempts, attemptMetrics, retried: true, failoverUsed: true };
}
