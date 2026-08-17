/** Shared types for pi-actions-bot */

export interface ActionInputs {
  // Trigger
  triggerPhrase: string;
  // Model
  provider: string;
  model: string;
  thinking: string;
  // Behavior
  prompt: string;
  systemPrompt: string;
  maxTurns: number;
  /** Wall-clock timeout for one pi invocation, in seconds. */
  runTimeoutSeconds: number;
  /**
   * Stream-idle watchdog, in seconds. 0 disables it.
   *
   * The wall-clock timer above cannot tell a silent process from a slow one:
   * both consume the whole budget and both report `timeout`. This second,
   * INDEPENDENT timer measures the gap between consecutive pi stream events, so
   * a hung provider request is terminated near the idle threshold and reported
   * as `stall` — a distinct failure class the retry policy can act on.
   */
  stallTimeoutSeconds: number;
  tools: string;
  /** Repo-local config file path, e.g. .elek.yml. */
  configPath: string;
  baseBranch?: string;
  branchPrefix: string;
  actorFilter: string;
  allowedBots: string;
  stickyComment: boolean;
  /** Mode: review (default), review+edit, or agent (legacy). */
  mode: string;
  /**
   * Review orchestration strategy:
   * - solo: one reviewer, current behavior
   * - crosscheck: two independent read-only lenses, then synthesis
   * - council: four independent read-only lenses, then synthesis
   * - thermos: N independent Thermos-style audit lenses, then synthesis
   */
  reviewStrategy: string;
  /** Optional comma-separated model specs for reviewer lenses. */
  reviewModels: string;
  /** Optional comma-separated built-in lens IDs for multi-agent reviews. */
  reviewLenses?: string;
  /** Optional number of parallel reviewer agents for thermos strategy. */
  reviewAgentCount?: number;
  /** Optional model spec for the independent advisor audit. */
  advisorModel?: string;
  /** Optional thinking level for the independent advisor audit. */
  advisorThinking?: string;
  /** Optional model spec for the final orchestrator/validator. */
  validatorModel: string;
  /** Optional thinking level for the final orchestrator/validator. */
  validatorThinking: string;
  /** Optional prompt-level severity threshold for reported findings. */
  severityThreshold: "" | "critical" | "important" | "minor";
  /** Show estimated review cost in logs, outputs, and comments. */
  showCost: boolean;
  /**
   * Optional pricing overrides:
   * model=inputPerMillion:outputPerMillion,...
   */
  costRates: string;
  /**
   * Optional soft cap for the estimated review cost. When a multi-lens
   * strategy would exceed this cap before execution, elek downgrades to a
   * cheaper strategy.
  */
  maxCostUsd?: number | null;
}

export interface GitHubEntityContext {
  eventName: "pull_request" | "issues" | "issue_comment" | "pull_request_review" | "pull_request_review_comment";
  eventAction: string;
  actor: string;
  actorAssociation?: string;
  repo: { owner: string; repo: string; fullName: string; defaultBranch: string };
  entityNumber: number;
  isPR: boolean;
  /** The body/comment text that triggered the action */
  triggerText: string;
  /** PR-specific fields */
  pr?: {
    title: string;
    body: string;
    headRef: string;
    baseRef: string;
    headSha: string;
    baseSha: string;
  };
  /** Issue-specific fields */
  issue?: {
    title: string;
    body: string;
    labels: string[];
    assignees: string[];
  };
}

/**
 * Why a pi run ended badly.
 *
 * This is the TOTAL set of terminal classes the retry policy is allowed to
 * branch on. It replaces the previous implicit `"stall" | "timeout"` reading of
 * a sanitized error string: retry behaviour must never be inferred by matching
 * prose, because the prose is provider-controlled and changes without notice.
 *
 * - `stall`              the stream-idle watchdog fired: no valid pi stream
 *                        activity for `stallTimeoutSeconds`.
 * - `timeout`            the wall-clock budget expired while work was ongoing.
 * - `max_turns`          pi started more turns than `maxTurns` allows.
 * - `invalid_output`     pi exited cleanly but produced nothing usable.
 * - `provider_transient` a structured provider status that is worth one retry
 *                        on the SAME model (429, 5xx, and similar).
 * - `provider_permanent` a structured provider status that a retry cannot fix
 *                        (authentication, authorization, configuration).
 * - `process_error`      the child process itself failed (spawn error, or a
 *                        non-zero exit with no other established cause).
 * - `unknown`            elek could not establish a class. Never retried.
 */
export type PiFailureClass =
  | "stall"
  | "timeout"
  | "max_turns"
  | "invalid_output"
  | "provider_transient"
  | "provider_permanent"
  | "process_error"
  | "unknown";

/** The subset of PiFailureClass that elek itself causes by killing the child. */
export type PiTerminationReason = "stall" | "timeout" | "max_turns";

/**
 * Stream telemetry for one physical pi attempt.
 *
 * Every field is additive and optional so an older consumer of the review
 * summary keeps working. `stall_timeout_seconds` is calibrated FROM these
 * numbers — specifically from `maxIdleSecondsObserved` across SUCCESSFUL runs —
 * so they have to be emitted before the threshold can be justified.
 */
export interface PiStreamTelemetry {
  /** Seconds from spawn to the first valid stream event; null if none arrived. */
  timeToFirstEventSeconds?: number | null;
  /** Largest observed gap between consecutive stream events, in seconds. */
  maxIdleSecondsObserved?: number;
  /** Count of successfully parsed pi stream events (raw stdout chunks in text mode). */
  streamEventCount?: number;
  /** Count of stdout lines that did not parse as JSON. Diagnostics only — these never reset the idle timer. */
  malformedLineCount?: number;
  /** `type` of the last successfully parsed stream event. */
  lastEventType?: string;
}

export interface PiRunResult extends PiStreamTelemetry {
  conclusion: "success" | "failure";
  output: string;
  sessionId?: string;
  turnsUsed: number;
  providerRetries: number;
  durationSeconds: number;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
    modelLabel: string;
    source: "builtin" | "override" | "provider" | "unknown";
  };
  /** Set whenever `conclusion` is "failure". Absent on success. */
  failureClass?: PiFailureClass;
  /** Set ONLY when elek terminated the child itself. Absent when pi exited on its own. */
  terminationReason?: PiTerminationReason;
}

export interface PrepareResult {
  commentId?: number;
  branchName?: string;
  baseBranch: string;
  promptText: string;
}
