import { parseDocument } from "yaml";

export type ReasoningMode = "effort" | "enabled";
export type ReasoningModes = Record<string, ReasoningMode>;
export interface ReasoningTelemetry {
  requestedThinking: string;
  piThinking: string;
  configuredMode: ReasoningMode;
  effectiveControl: "off" | "named-effort" | "provider-default" | "max-tokens";
  effort?: string;
  maxTokens?: number;
  adapted: boolean;
}
export const REASONING_MODES_ENV = "ELEK_OPENROUTER_REASONING_MODES";
export const REASONING_THINKING_ENV = "ELEK_REQUESTED_THINKING";
export const REASONING_TELEMETRY_PREFIX = "ELEK_REASONING:";
export const REASONING_NOT_APPLICABLE = `${REASONING_TELEMETRY_PREFIX}{"notApplicable":true}`;
export const REASONING_MAX_TOKENS_ENV = "ELEK_REASONING_MAX_TOKENS";

export function normalizeReasoningModel(id: string): string {
  return id.trim().replace(/^openrouter\//, "");
}

export function parseReasoningModes(raw: string): ReasoningModes {
  if (!raw.trim()) return {};
  const invalid = () => new Error("Invalid openrouter_model_reasoning_modes: expected a JSON object of canonical model IDs mapped to effort or enabled, without conflicting or duplicate keys.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  // JSON.parse discards duplicate literal keys before normalization can see them.
  if (parseDocument(raw, { uniqueKeys: true }).errors.length > 0) throw invalid();
  const modes: ReasoningModes = {};
  for (const [key, mode] of Object.entries(value)) {
    const id = normalizeReasoningModel(key);
    if (!/^[a-z0-9~][a-z0-9._~-]*\/[a-z0-9][a-z0-9._:-]*$/.test(id) ||
      (mode !== "effort" && mode !== "enabled") ||
      (Object.hasOwn(modes, id) && modes[id] !== mode)) throw invalid();
    modes[id] = mode;
  }
  return modes;
}

export function piThinkingLevel(thinking: string): string {
  const normalized = thinking.trim().toLowerCase();
  return normalized === "max" ? "xhigh" : normalized;
}

export function validateReasoningSchedule(maxTokens: number | undefined, thinking: readonly string[]): void {
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 ||
    thinking.some((value) => piThinkingLevel(value) === "off"))) {
    throw new Error("Invalid reasoning_max_tokens: use a positive safe integer and enable thinking for every scheduled run.");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Undefined preserves Pi's payload identity and every later hook's input. */
export function buildReasoningPayload(
  payload: Record<string, unknown>, maxTokens: number | undefined,
  options: { mode: ReasoningMode; thinking: string } = { mode: "effort", thinking: "high" },
): Record<string, unknown> | undefined {
  validateReasoningSchedule(maxTokens, [options.thinking]);
  if (options.mode === "effort" && maxTokens === undefined) return undefined;
  let base = payload;
  // MiMo rejects Pi's OpenAI token-limit alias under require_parameters=true.
  // Keep the output limit unchanged; it is separate from the reasoning budget.
  if (options.mode === "enabled" && Object.hasOwn(payload, "max_completion_tokens")) {
    const { max_completion_tokens, ...rest } = payload;
    base = { ...rest, max_tokens: max_completion_tokens };
  }
  if (piThinkingLevel(options.thinking) === "off") {
    if (!Object.hasOwn(base, "reasoning")) return base === payload ? undefined : base;
    const { reasoning: _reasoning, ...rest } = base;
    return rest;
  }
  const { effort: _effort, enabled: _enabled, max_tokens: _maxTokens, ...rest } = object(base.reasoning);
  return { ...base, reasoning: { ...rest, ...(maxTokens === undefined ? { enabled: true } : { max_tokens: maxTokens }) } };
}

export interface ReasoningRequestOptions {
  model: { id: string; provider: string; reasoning: boolean };
  modes: ReasoningModes;
  thinking: string;
  requestedThinking: string;
  maxTokens?: number;
}

export function shapeReasoningRequest(payload: Record<string, unknown>, options: ReasoningRequestOptions): {
  payload: Record<string, unknown> | undefined; reasoning: ReasoningTelemetry;
} {
  const openrouter = options.model.provider === "openrouter";
  const mode = openrouter ? options.modes[normalizeReasoningModel(options.model.id)] ?? "effort" : "effort";
  const shaped = openrouter && options.model.reasoning
    ? buildReasoningPayload(payload, options.maxTokens, { mode, thinking: options.thinking }) : undefined;
  const control = object((shaped ?? payload).reasoning);
  const off = !options.model.reasoning || piThinkingLevel(options.thinking) === "off";
  const maxTokens = typeof control.max_tokens === "number" ? control.max_tokens : undefined;
  const effort = typeof control.effort === "string" ? control.effort : undefined;
  return { payload: shaped, reasoning: {
    requestedThinking: options.requestedThinking, piThinking: piThinkingLevel(options.thinking), configuredMode: mode,
    effectiveControl: off ? "off" : maxTokens !== undefined ? "max-tokens" : effort ? "named-effort" : "provider-default",
    ...(!off && maxTokens !== undefined ? { maxTokens } : {}),
    ...(!off && maxTokens === undefined && effort ? { effort } : {}),
    adapted: shaped !== undefined,
  } };
}

/** Only this fixed control schema may cross the child's stderr telemetry channel. */
export function parseReasoningTelemetry(line: string): ReasoningTelemetry | undefined {
  if (!line.startsWith(REASONING_TELEMETRY_PREFIX) || line.length > 1024) return undefined;
  let raw: Record<string, unknown>;
  try { raw = object(JSON.parse(line.slice(REASONING_TELEMETRY_PREFIX.length))); } catch { return undefined; }
  const levels = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!levels.includes(String(raw.requestedThinking)) || !levels.includes(String(raw.piThinking)) ||
    !["effort", "enabled"].includes(String(raw.configuredMode)) ||
    !["off", "named-effort", "provider-default", "max-tokens"].includes(String(raw.effectiveControl)) ||
    typeof raw.adapted !== "boolean") return undefined;
  if (raw.effectiveControl === "named-effort" && (!levels.includes(String(raw.effort)) || raw.maxTokens !== undefined)) return undefined;
  if (raw.effectiveControl === "max-tokens" && (!Number.isSafeInteger(raw.maxTokens) || Number(raw.maxTokens) <= 0 || raw.effort !== undefined)) return undefined;
  if (["off", "provider-default"].includes(String(raw.effectiveControl)) && (raw.effort !== undefined || raw.maxTokens !== undefined)) return undefined;
  return {
    requestedThinking: String(raw.requestedThinking), piThinking: String(raw.piThinking),
    configuredMode: raw.configuredMode as ReasoningMode,
    effectiveControl: raw.effectiveControl as ReasoningTelemetry["effectiveControl"],
    ...(raw.effectiveControl === "named-effort" ? { effort: String(raw.effort) } : {}),
    ...(raw.effectiveControl === "max-tokens" ? { maxTokens: Number(raw.maxTokens) } : {}), adapted: raw.adapted,
  };
}
