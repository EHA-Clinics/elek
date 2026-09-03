import type { GitHubEntityContext, PiFailureClass, PiRunResult } from "../types.js";
import type { CouncilPolicyResult } from "./council-policy.js";
import type { DiffPromptBudgetReport } from "./strategy.js";
import type { ReviewCost, ReviewCostTotal } from "./cost.js";
import type { PostSummary } from "../entrypoints/post-buffered.js";
import { uniqueFindingId, type ParsedReviewFinding } from "./findings.js";

export type ReviewRunRole = "reviewer" | "validator-review" | "validator";

export interface ReviewRunMetric {
  role: ReviewRunRole;
  lensId?: string;
  lensTitle?: string;
  /** The model the DECISIVE attempt actually ran on. */
  modelLabel: string;
  conclusion: "success" | "failure";
  turnsUsed: number;
  providerRetries: number;
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimated: boolean;
  pricingSource: ReviewCost["source"];
  /**
   * Additive, optional fields (EHAC-2231). One entry per LOGICAL lens is
   * preserved so quorum arithmetic stays 1:1 with the council; these describe how
   * that one entry was reached without splitting it into two.
   */
  failureClass?: PiFailureClass;
  providerHttpStatus?: number;
  providerIneligibilityReasons?: string[];
  /** The model this lens was originally assigned, before any failover. */
  assignedModelLabel?: string;
  /** The model the decisive attempt ran on. Equals modelLabel; named for the census. */
  actualModelLabel?: string;
  /** True when the decisive attempt ran on a replacement model. */
  failoverUsed?: boolean;
  /** Physical attempts spent on this logical lens (1 or 2). */
  attemptCount?: number;
  /**
   * The OpenRouter endpoint that actually SERVED this run (EHAC-2280, AC #1), e.g.
   * "DeepInfra". Without it, `modelLabel` alone cannot distinguish "the review timed
   * out" from "the review was routed to a slow endpoint of the same model" — and
   * those two call for opposite remedies.
   *
   * ABSENT on any run that did not go through OpenRouter. `null` when the lookup ran
   * and could not report — not reported, never a pass and never a failure. See
   * `src/openrouter-generation.ts` for the chain, which was proven end to end in CI
   * rather than assumed, including the positive control that two runs pinned to
   * different endpoints report different values.
   */
  servingProvider?: string | null;
  /**
   * Always `null`. Quantization is not a field of OpenRouter's generation endpoint —
   * confirmed against the live endpoint. It can be CONSTRAINED request-side via
   * `provider.quantizations` (`src/openrouter-routing.ts`), which is a different
   * fact, and must never be inferred from.
   */
  quantization?: null;
  /**
   * Reasoning tokens the serving endpoint billed for this run. pi's own `Usage`
   * reports none, so this is the only route to the number — and it is what should
   * size a reasoning cap, rather than benchmark prose.
   */
  nativeTokensReasoning?: number | null;
  /** Provider-reported generation time and time-to-first-token, milliseconds. */
  generationTimeMs?: number | null;
  latencyMs?: number | null;
}

/**
 * One PHYSICAL attempt.
 *
 * Separate from `ReviewRunMetric` on purpose. A retried lens is still ONE lens
 * for quorum purposes but TWO executions for cost, latency and diagnosis, and
 * folding them together is what made the previous retry invisible in the record:
 * `retriedLensIds` said a retry happened but not what it cost, what it changed,
 * or why it was attempted.
 */
export interface ReviewAttemptMetric {
  lensId: string;
  lensTitle?: string;
  role: ReviewRunRole;
  /** 1-based within this logical lens. */
  attempt: number;
  assignedModel: string;
  actualModel: string;
  failover: boolean;
  conclusion: "success" | "failure";
  failureClass?: PiFailureClass;
  providerHttpStatus?: number;
  providerIneligibilityReasons?: string[];
  terminationReason?: string;
  durationSeconds: number;
  turnsUsed: number;
  providerRetries: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** What the packer actually gave THIS attempt's prompt. */
  promptBudget?: DiffPromptBudgetReport;
  timeToFirstEventSeconds?: number | null;
  maxIdleSecondsObserved?: number;
  streamEventCount?: number;
  malformedLineCount?: number;
  lastEventType?: string;
}

export interface ReviewSummaryInput {
  context: GitHubEntityContext;
  runId: string;
  jobRunLink: string;
  conclusion: "success" | "failure";
  mode: string;
  requestedStrategy: string;
  executedStrategy: string;
  primaryModelLabel: string;
  finalModelLabel: string;
  startedAt: Date;
  finishedAt: Date;
  commentId?: number;
  branchName?: string;
  inlineComments: PostSummary;
  costTotal: ReviewCostTotal;
  runs: ReviewRunMetric[];
  findings?: ParsedReviewFinding[];
  /**
   * The diff budget each prompt actually received. Additive and optional, so
   * `version` stays 1 — no existing consumer breaks, and a consumer that wants
   * these values must detect them by presence anyway to tolerate older refs.
   */
  promptBudgets?: DiffPromptBudgetReport[];
  /** Lens IDs that failed once and were retried. */
  retriedLensIds?: string[];
  /** Every physical attempt, in completion order. Additive; `version` stays 1. */
  attempts?: ReviewAttemptMetric[];
  /**
   * WHICH supported terminal path emitted this summary. A consumer that has to
   * distinguish "the review declined" from "the review broke before it started"
   * currently has to infer it from an empty output, and inferring a decline from
   * an absence is the fail-open this whole record exists to remove.
   */
  terminalReason?: string;
  /** Set only on an explicit decline. Zero runs plus any other reason is a failure. */
  skipReason?: string;
  /** Human-readable failure detail for a failure summary. */
  failureMessage?: string;
  /**
   * The degraded-reviewer-lens tolerance this run actually applied, so a
   * downstream gate can detect producer/gate policy drift instead of assuming
   * two independently-defaulted values happen to agree.
   */
  councilPolicy?: CouncilPolicyResult;
}

export function metricFromPiRun(
  result: PiRunResult,
  role: ReviewRunMetric["role"],
  metadata: {
    lensId?: string;
    lensTitle?: string;
    assignedModelLabel?: string;
    actualModelLabel?: string;
    failoverUsed?: boolean;
    attemptCount?: number;
  } = {},
): ReviewRunMetric {
  return {
    role,
    ...metadata,
    modelLabel: result.usage.modelLabel,
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(result.providerHttpStatus !== undefined
      ? { providerHttpStatus: result.providerHttpStatus }
      : {}),
    ...(result.providerIneligibilityReasons
      ? { providerIneligibilityReasons: result.providerIneligibilityReasons }
      : {}),
    // EHAC-2280 AC #1. Spread with the same idiom as failureClass above so the shape
    // stays additive: an older consumer of the review summary keeps working and
    // `version: 1` does not move. Tested `!== undefined`, not truthiness — a real
    // `null` (looked up, not reported) and a real `0` reasoning-token count must both
    // survive into the record, and a truthiness test would silently drop them.
    ...(result.servingProvider !== undefined ? { servingProvider: result.servingProvider } : {}),
    ...(result.quantization !== undefined ? { quantization: result.quantization } : {}),
    ...(result.nativeTokensReasoning !== undefined
      ? { nativeTokensReasoning: result.nativeTokensReasoning }
      : {}),
    ...(result.generationTimeMs !== undefined ? { generationTimeMs: result.generationTimeMs } : {}),
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
    conclusion: result.conclusion,
    turnsUsed: result.turnsUsed,
    providerRetries: result.providerRetries,
    durationSeconds: roundSeconds(result.durationSeconds),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: roundUsd(result.costUsd),
    costEstimated: result.usage.estimated,
    pricingSource: result.usage.source,
  };
}

export function buildReviewSummary(input: ReviewSummaryInput) {
  const entityType = input.context.isPR ? "pull_request" : "issue";
  const usedFindingIds = new Set<string>();
  const inlineComments: Record<string, number> = {
    posted: input.inlineComments.posted,
    skipped: input.inlineComments.skipped,
    failed: input.inlineComments.failed,
  };
  if ((input.inlineComments.duplicate ?? 0) > 0) {
    inlineComments.duplicate = input.inlineComments.duplicate ?? 0;
  }

  return {
    version: 1,
    generatedAt: input.finishedAt.toISOString(),
    repository: input.context.repo.fullName,
    run: {
      id: input.runId,
      url: input.jobRunLink,
      durationSeconds: roundSeconds(
        (input.finishedAt.getTime() - input.startedAt.getTime()) / 1000,
      ),
      conclusion: input.conclusion,
    },
    entity: {
      type: entityType,
      number: input.context.entityNumber,
      title: input.context.pr?.title || input.context.issue?.title || "",
      actor: input.context.actor,
      event: input.context.eventName,
      action: input.context.eventAction,
    },
    review: {
      mode: input.mode,
      requestedStrategy: input.requestedStrategy || "solo",
      executedStrategy: input.executedStrategy,
      primaryModel: input.primaryModelLabel,
      finalModel: input.finalModelLabel,
      branchName: input.branchName || "",
      commentId: input.commentId ? String(input.commentId) : "",
      terminalReason: input.terminalReason ?? "completed",
      skipReason: input.skipReason ?? "",
      failureMessage: input.failureMessage ?? "",
    },
    inlineComments,
    findings: (input.findings ?? []).map((finding, index) => ({
      ...finding,
      id: uniqueFindingId(finding.title, index, usedFindingIds, finding.id),
    })),
    cost: {
      usd: roundUsd(input.costTotal.costUsd),
      inputTokens: input.costTotal.inputTokens,
      outputTokens: input.costTotal.outputTokens,
      estimated: input.costTotal.estimated,
      runs: input.costTotal.runs.map((run) => costRunSummary(run)),
    },
    modelRuns: input.runs,
    attempts: input.attempts ?? [],
    promptBudgets: input.promptBudgets ?? [],
    retriedLensIds: input.retriedLensIds ?? [],
    councilPolicy: input.councilPolicy ?? null,
  };
}

function costRunSummary(run: ReviewCost) {
  return {
    modelLabel: run.modelLabel,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: roundUsd(run.costUsd),
    estimated: run.estimated,
    pricingSource: run.source,
  };
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function roundUsd(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}
