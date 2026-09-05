/**
 * Parse the GitHub Actions event context into a structured format.
 * Handles pull_request, issues, issue_comment, pull_request_review events.
 */
import * as core from "@actions/core";
import { readFileSync } from "fs";
import type { GitHubEntityContext, ActionInputs } from "../types.js";
import { parseReasoningModes } from "../openrouter-reasoning.js";
import { parseOpenRouterProviderPreferences } from "../openrouter-routing.js";

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return !["false", "0", "off", "no"].includes(normalized);
}

function parseSeverityInput(value: string): ActionInputs["severityThreshold"] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "critical" || normalized === "important" || normalized === "minor") {
    return normalized;
  }
  core.warning(`Ignoring invalid severity_threshold input: ${normalized}`);
  return "";
}

function parseMaxCostInput(value: string): number | null | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (["0", "off", "none", "false", "disabled"].includes(normalized.toLowerCase())) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    core.warning(`Ignoring invalid max_cost_usd input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

function parseReviewAgentCountInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    core.warning(`Ignoring invalid review_agent_count input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

function parsePositiveIntegerInput(name: string, value: string, defaultValue: number): number {
  const normalized = value.trim();
  if (!normalized) return defaultValue;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    core.warning(`Ignoring invalid ${name} input: ${normalized}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse `stall_timeout_seconds`, FAILING CLOSED on anything unreadable.
 *
 * Deliberately unlike `parsePositiveIntegerInput` above, which warns and falls
 * back to its default. A watchdog is a safety mechanism: silently disabling it
 * (or silently widening it) because someone typed `12O` would leave the review
 * exposed to exactly the hang this input exists to bound, behind a green log
 * line. A misconfigured watchdog is a configuration failure, and it must be
 * reported before any model runs rather than discovered 600 seconds later.
 *
 * An EMPTY value is not a misconfiguration — it is the documented default, and
 * the documented default is 0 (disabled), so a consumer that never sets this
 * input behaves exactly as it did before the input existed.
 *
 * @throws {Error} when the value is present and not a non-negative integer.
 */
export function parseStallTimeoutSecondsInput(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid stall_timeout_seconds input: "${normalized}". ` +
        "Expected a non-negative integer number of seconds (0 disables the stream-idle watchdog). " +
        "Refusing to run: a watchdog that silently disables itself on a typo is not a watchdog.",
    );
  }
  return parsed;
}

/**
 * Parse `job_timeout_minutes`, FAILING CLOSED on anything unreadable.
 *
 * Modelled on `parseStallTimeoutSecondsInput` above rather than on
 * `parsePositiveIntegerInput`, and for the same reason. This value is only ever
 * read to assert a safety precondition (see `assessSerialBudget`). A parser that
 * warned and fell back would resolve a typo into a DIFFERENT cap than the runner
 * is actually enforcing, and would then cheerfully report that the arithmetic
 * checks out against a number nobody configured.
 *
 * An EMPTY value is not a misconfiguration — it is the documented absence of the
 * input, and it is what every consumer that has not adopted it yet will send.
 * Absence returns `undefined` so the guard can report `unchecked` instead of
 * silently passing.
 *
 * @throws {Error} when the value is present and not a positive integer.
 */
export function parseJobTimeoutMinutesInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  // Plain decimal digits ONLY, deliberately stricter than a bare `Number()` check.
  // `Number("1e2")` is 100 and `Number.isInteger` accepts it, so a `Number()`-based
  // guard would silently read `1e2` as a 100-minute cap. Anything that is not the
  // literal integer someone meant to type is a configuration error here.
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid job_timeout_minutes input: "${normalized}". ` +
        "Expected a positive integer number of minutes. " +
        "Refusing to run: this value is used to assert that the serial wall-clock budget fits " +
        "inside the job cap, and asserting it against a misread number is worse than not asserting it.",
    );
  }
  return parsed;
}

/**
 * Parse `reasoning_max_tokens`, FAILING CLOSED on anything unreadable.
 *
 * Same doctrine as the two safety parsers above. An EMPTY value is not a
 * misconfiguration — it is the SHIPPED DEFAULT. Nothing is sent, no extension is
 * loaded, and the run is byte-for-byte what it was before this input existed.
 *
 * @throws {Error} when the value is present and not a positive integer.
 */
export function parseReasoningMaxTokensInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  // Plain decimal digits only. `Number("1e5")` is 100000 and passes Number.isInteger,
  // so a bare Number() guard would read `1e5` as a cap nobody typed.
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid reasoning_max_tokens input: "${normalized}". ` +
        "Expected a positive integer number of tokens. " +
        "Refusing to run: a misread value would silently shape the reasoning depth of every " +
        "review, and a cap is only worth setting against a number you meant to type.",
    );
  }
  return parsed;
}

/**
 * Parse `max_degraded_lenses`, resolving anything unreadable to 0 (strict).
 *
 * Warn-and-clamp rather than throw, unlike `stall_timeout_seconds`: a
 * misconfigured tolerance that resolves to 0 is exactly the pre-existing
 * behaviour, so it is safe to continue. What must never happen is the opposite —
 * a typo widening what the review accepts. Fail closed, always in the strict
 * direction.
 */
export function parseMaxDegradedLensesInput(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    core.warning(
      `Ignoring invalid max_degraded_lenses input: ${normalized}. Using 0 (strict) — ` +
        "a misconfigured tolerance must never widen what the review accepts.",
    );
    return 0;
  }
  return parsed;
}

export function parseInputs(): ActionInputs {
  return {
    triggerPhrase: core.getInput("trigger_phrase") || "@pi",
    provider: core.getInput("provider") || "anthropic",
    model: core.getInput("model") || "",
    thinking: core.getInput("thinking") || "medium",
    prompt: core.getInput("prompt") || "",
    systemPrompt: core.getInput("system_prompt") || "",
    maxTurns: parseInt(core.getInput("max_turns") || "20", 10),
    runTimeoutSeconds: parsePositiveIntegerInput("run_timeout_seconds", core.getInput("run_timeout_seconds"), 600),
    jobTimeoutMinutes: parseJobTimeoutMinutesInput(core.getInput("job_timeout_minutes")),
    openRouterProviderPreferences: parseOpenRouterProviderPreferences(
      core.getInput("openrouter_provider_preferences"),
    ),
    openRouterReasoningModes: parseReasoningModes(core.getInput("openrouter_model_reasoning_modes")),
    reasoningMaxTokens: parseReasoningMaxTokensInput(core.getInput("reasoning_max_tokens")),
    stallTimeoutSeconds: parseStallTimeoutSecondsInput(core.getInput("stall_timeout_seconds")),
    tools: core.getInput("tools") || "",
    configPath: core.getInput("config_path") || ".elek.yml",
    baseBranch: core.getInput("base_branch") || undefined,
    branchPrefix: core.getInput("branch_prefix") || "elek/",
    actorFilter: core.getInput("actor_filter") || "",
    allowedBots: core.getInput("allowed_bots") || "",
    stickyComment: parseBooleanInput(core.getInput("sticky_comment"), true),
    mode: core.getInput("mode") || "review",
    reviewStrategy: core.getInput("review_strategy") || "",
    reviewModels: core.getInput("review_models") || "",
    reviewLenses: core.getInput("review_lenses") || "",
    maxDegradedLenses: parseMaxDegradedLensesInput(core.getInput("max_degraded_lenses")),
    reviewAgentCount: parseReviewAgentCountInput(core.getInput("review_agent_count")),
    advisorModel: core.getInput("advisor_model") || "",
    advisorThinking: core.getInput("advisor_thinking") || "",
    validatorModel: core.getInput("validator_model") || "",
    validatorThinking: core.getInput("validator_thinking") || "",
    severityThreshold: parseSeverityInput(core.getInput("severity_threshold")),
    showCost: parseBooleanInput(core.getInput("show_cost"), true),
    costRates: core.getInput("cost_rates") || "",
    maxCostUsd: parseMaxCostInput(core.getInput("max_cost_usd")),
  };
}

/**
 * Parse the GitHub event payload into a structured entity context.
 * Returns null for unsupported event types.
 */
export function parseEntityContext(): GitHubEntityContext | null {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) throw new Error("GITHUB_EVENT_NAME not set");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH not set");

  const payload = JSON.parse(readFileSync(eventPath, "utf-8"));

  const actor = process.env.GITHUB_ACTOR || payload.sender?.login || "unknown";

  const repo = {
    owner: process.env.GITHUB_REPOSITORY_OWNER || payload.repository?.owner?.login || "",
    repo: (process.env.GITHUB_REPOSITORY || "").split("/")[1] || payload.repository?.name || "",
    fullName: process.env.GITHUB_REPOSITORY || payload.repository?.full_name || "",
    defaultBranch: payload.repository?.default_branch || "main",
  };

  const base: Pick<GitHubEntityContext, "actor" | "repo" | "triggerText" | "isPR" | "entityNumber"> = {
    actor,
    repo,
    triggerText: "",
    isPR: false,
    entityNumber: 0,
  };

  switch (eventName) {
    case "pull_request":
    case "pull_request_target": {
      const pr = payload.pull_request;
      if (!pr) return null;
      return {
        ...base,
        eventName: "pull_request",
        eventAction: payload.action || "opened",
        actorAssociation: pr.author_association,
        entityNumber: pr.number,
        isPR: true,
        triggerText: pr.body || "",
        pr: {
          title: pr.title || "",
          body: pr.body || "",
          headRef: pr.head?.ref || "",
          baseRef: pr.base?.ref || "",
          headSha: pr.head?.sha || "",
          baseSha: pr.base?.sha || "",
        },
      };
    }

    case "issues": {
      const issue = payload.issue;
      if (!issue || issue.pull_request) return null; // skip PRs that show up as issues
      return {
        ...base,
        eventName: "issues",
        eventAction: payload.action || "opened",
        actorAssociation: issue.author_association,
        entityNumber: issue.number,
        isPR: false,
        triggerText: issue.body || "",
        issue: {
          title: issue.title || "",
          body: issue.body || "",
          labels: (issue.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
          assignees: (issue.assignees || []).map((a: any) => a.login),
        },
      };
    }

    case "issue_comment": {
      const comment = payload.comment;
      const issue = payload.issue;
      if (!comment || !issue) return null;
      const isPR = !!issue.pull_request;
      return {
        ...base,
        eventName: "issue_comment",
        eventAction: payload.action || "created",
        actorAssociation: comment.author_association,
        entityNumber: issue.number,
        isPR,
        triggerText: comment.body || "",
        ...(isPR
          ? { pr: { title: issue.title || "", body: issue.body || "", headRef: "", baseRef: "", headSha: "", baseSha: "" } }
          : { issue: { title: issue.title || "", body: issue.body || "", labels: [], assignees: [] } }),
      };
    }

    case "pull_request_review": {
      const review = payload.review;
      const pr = payload.pull_request;
      if (!review || !pr) return null;
      return {
        ...base,
        eventName: "pull_request_review",
        eventAction: payload.action || "submitted",
        actorAssociation: review.author_association,
        entityNumber: pr.number,
        isPR: true,
        triggerText: review.body || "",
        pr: {
          title: pr.title || "",
          body: pr.body || "",
          headRef: pr.head?.ref || "",
          baseRef: pr.base?.ref || "",
          headSha: pr.head?.sha || "",
          baseSha: pr.base?.sha || "",
        },
      };
    }

    case "pull_request_review_comment": {
      const reviewComment = payload.comment;
      const pr = payload.pull_request;
      if (!reviewComment || !pr) return null;
      return {
        ...base,
        eventName: "pull_request_review_comment",
        eventAction: payload.action || "created",
        actorAssociation: reviewComment.author_association,
        entityNumber: pr.number,
        isPR: true,
        triggerText: reviewComment.body || "",
        pr: {
          title: pr.title || "",
          body: pr.body || "",
          headRef: pr.head?.ref || "",
          baseRef: pr.base?.ref || "",
          headSha: pr.head?.sha || "",
          baseSha: pr.base?.sha || "",
        },
      };
    }

    default:
      return null;
  }
}
