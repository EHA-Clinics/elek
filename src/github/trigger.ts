/**
 * Trigger detection for the elek action.
 * Checks if the event should trigger pi based on mentions, labels, assignees, or explicit prompts.
 */
import type { GitHubEntityContext, ActionInputs } from "../types";

/**
 * Check if the current event context contains a trigger for pi to act.
 * Returns the extracted user prompt text, or null if not triggered.
 */
export function detectTrigger(
  context: GitHubEntityContext,
  inputs: ActionInputs,
): string | null {
  // Explicit prompt from workflow config always triggers
  if (inputs.prompt) {
    return inputs.prompt;
  }

  const trigger = inputs.triggerPhrase.toLowerCase();
  const text = context.triggerText.toLowerCase();

  // Check for trigger phrase in comment/body
  const idx = findTriggerIndex(text, trigger);
  if (idx >= 0) {
    // Extract everything after the trigger phrase as the user's request
    const afterTrigger = context.triggerText.substring(idx + trigger.length).trim();
    return afterTrigger || context.triggerText;
  }

  // Check for assignee trigger (configured assignee username)
  if (context.issue?.assignees) {
    // If the issue has assignees, check if any match (useful for triage workflows)
    // Keep assignee matching simple and explicit.
  }

  // Check for label trigger
  if (context.issue?.labels) {
    const labelTrigger = "pi"; // default label trigger
    if (context.issue.labels.some((l) => l.toLowerCase() === labelTrigger)) {
      return context.triggerText;
    }
  }

  return null;
}

function listIncludes(raw: string | undefined, actor: string): boolean {
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(actor);
}

/**
 * Check if the actor is allowed to trigger pi.
 *
 * `allowed_bots` and `actor_filter` are INDEPENDENT permissions:
 *
 *   - `*` in either input allows everyone.
 *   - Bots are opt-in only: a `*[bot]` actor triggers a review only when named
 *     in `allowed_bots`. `actor_filter` has no bearing on bots.
 *   - Humans are governed by `actor_filter` alone. When it is set it is an
 *     authoritative allowlist (an unlisted human is denied even if trusted);
 *     when it is unset, repository trust decides — OWNER / MEMBER / COLLABORATOR,
 *     with a live permission lookup as fallback in `isActorAuthorized`.
 *     `allowed_bots` has no bearing on humans.
 *
 * WHY THE SPLIT. Setting EITHER input used to skip the default-trust branch and
 * fall through to a bare `return false`. So adding `allowed_bots: renovate[bot]`
 * — an apparently additive change, and the documented way to get dependency PRs
 * reviewed — silently stopped reviewing every HUMAN pull request, and
 * `isActorAuthorized` then declined to even attempt its permission fallback.
 * The failure is invisible: a denied actor exits cleanly and the required status
 * check goes green with no review behind it.
 *
 * The narrowing behaviour of `actor_filter` is deliberate and is preserved
 * exactly. What is fixed is the entanglement: a bot allowlist must not decide
 * anything about humans.
 */
export function isActorAllowed(context: GitHubEntityContext, inputs: ActionInputs): boolean {
  const actor = context.actor;

  // Explicit allow-all, from either input.
  if (inputs.actorFilter === "*" || inputs.allowedBots === "*") {
    return true;
  }

  // Bots: opt-in only, and never eligible for the human trust path below.
  if (actor.endsWith("[bot]")) {
    return listIncludes(inputs.allowedBots, actor);
  }

  // Humans: actor_filter is authoritative when set, and narrows deliberately.
  if (inputs.actorFilter) {
    return listIncludes(inputs.actorFilter, actor);
  }

  return isTrustedAssociation(context.actorAssociation);
}

export interface ActorPermissionRequest {
  owner: string;
  repo: string;
  actor: string;
}

export type ActorPermissionLookup = (request: ActorPermissionRequest) => Promise<string | undefined>;

/**
 * Authorize an actor using webhook association first, then a live repository
 * permission lookup when GitHub supplies stale or missing association data.
 *
 * An explicit `actor_filter` remains authoritative for humans and never uses the
 * fallback — an unlisted human is denied without a lookup. `allowed_bots` no
 * longer suppresses the fallback, because it says nothing about humans; that
 * coupling is what silently disabled human review on any repo that allowlisted
 * a bot. Bots never reach the fallback — `allowed_bots` alone authorizes them.
 */
export async function isActorAuthorized(
  context: GitHubEntityContext,
  inputs: ActionInputs,
  lookupPermission?: ActorPermissionLookup,
): Promise<boolean> {
  if (isActorAllowed(context, inputs)) return true;

  if (inputs.actorFilter || context.actor.endsWith("[bot]") || !lookupPermission) {
    return false;
  }

  try {
    const permission = await lookupPermission({
      owner: context.repo.owner,
      repo: context.repo.repo,
      actor: context.actor,
    });
    return isTrustedPermission(permission);
  } catch {
    return false;
  }
}

function findTriggerIndex(text: string, trigger: string): number {
  if (!trigger) return -1;
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(trigger, from);
    if (index < 0) return -1;
    const before = index > 0 ? text[index - 1] : "";
    const after = text[index + trigger.length] ?? "";
    if (isBoundary(before) && isBoundary(after)) return index;
    from = index + 1;
  }
  return -1;
}

function isBoundary(char: string): boolean {
  return char === "" || /[\s.,:;!?()[\]{}<>"'`]/.test(char);
}

function isTrustedAssociation(value: string | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function isTrustedPermission(value: string | undefined): boolean {
  return value === "admin" || value === "maintain" || value === "write" || value === "triage";
}
