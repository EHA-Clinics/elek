import type { GitHubEntityContext, PiFailureClass, PiRunResult } from "../types.js";
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
  /** The model this lens was originally assigned, before any failover. */
  assignedModelLabel?: string;
  /** The model the decisive attempt ran on. Equals modelLabel; named for the census. */
  actualModelLabel?: string;
  /** True when the decisive attempt ran on a replacement model. */
  failoverUsed?: boolean;
  /** Physical attempts spent on this logical lens (1 or 2). */
  attemptCount?: number;
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
   * The degraded-reviewer-lens tolerance this run actually applied, so a
   * downstream gate can detect producer/gate policy drift instead of assuming
   * two independently-defaulted values happen to agree.
   */
  councilPolicy?: CouncilPolicyReport;
}

/**
 * The council policy elek applied, reported so it can be COMPARED downstream.
 *
 * `configured` is what the input asked for; `effective` is what was actually
 * enforced after fail-closed normalisation. They differ exactly when someone
 * misconfigured the knob, which is the case worth seeing.
 */
export interface CouncilPolicyReport {
  configuredMaxDegradedLenses: number | null;
  effectiveMaxDegradedLenses: number;
  status: "healthy" | "degraded" | "breached";
  reviewerLensesTotal: number;
  reviewerLensesFailed: number;
  failedReviewerLensIds: string[];
  failedValidatorRoleIds: string[];
  unclassifiedRunLabels: string[];
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
