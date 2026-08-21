/**
 * pi extension: bound reasoning spend on OpenRouter requests (EHAC-2280, step 4 / R-4).
 *
 * WHY AN EXTENSION AT ALL. pi exposes no `reasoning.max_tokens` config knob. Its
 * `modelOverrides.reasoning` is a BOOLEAN capability flag (verified in pi 0.83.0 at
 * `dist/core/model-config.js:136`), and `modelOverrides.maxTokens` is a TOTAL
 * completion cap — capping that would truncate the review itself, which is exactly
 * what R-4's "conservative" constraint forbids. The `before_provider_request` hook is
 * the only surface that can add a reasoning-specific cap, and the T1 spike confirmed
 * the payload really does carry `reasoning: { effort }` on the OpenRouter path.
 *
 * WHY IT SHIPS UNSET AND IS SET BY NOBODY. pi's `Usage` still reports no
 * reasoning-token count (`docs/session-format.md:105-118`), but the cap is no longer
 * unverifiable: `src/openrouter-generation.ts` now records `nativeTokensReasoning`
 * per run from `GET /api/v1/generation?id=`, observed live at 0 (DeepInfra) and 10
 * (Novita) for the SAME prompt. So a cap set here CAN be checked against what runs
 * actually spend.
 *
 * What does not exist yet is the fleet telemetry itself — the field ships in the same
 * release as this input, so nobody has collected a distribution to size a cap from.
 * That is the reason it stays unset, and it is now a "not measured yet" rather than a
 * "cannot be measured": read `nativeTokensReasoning` off a few council runs first,
 * then set this from the data instead of from benchmark prose.
 *
 * STDOUT IS OFF LIMITS. elek readline-parses pi's stdout as a JSON event stream
 * (`src/pi.ts` ~line 410); a single stray line lands in `malformedLineCount` and
 * degrades the run. This module therefore writes NOTHING, anywhere — no `console.*`,
 * no `process.stdout.write`, not even on error. elek additionally declines to load it
 * at all unless the input is set, so an unconfigured run carries no extension and no
 * risk whatsoever.
 */

/** Env var elek uses to hand the cap to the extension. Never passed via argv. */
export const REASONING_MAX_TOKENS_ENV = "ELEK_REASONING_MAX_TOKENS";

/**
 * Return the payload pi should send, or `undefined` to leave it untouched.
 *
 * Returning `undefined` is pi's documented "keep the payload unchanged" signal, and it
 * is a STRICTER no-op than returning a structurally identical copy: later handlers in
 * pi's extension chain see the original object identity.
 *
 * When a cap is set, the existing `reasoning` object is SPREAD, never replaced —
 * replacing it would silently drop `effort` and with it the review's thinking depth.
 */
export function buildReasoningPayload(
  payload: Record<string, unknown>,
  maxTokens: number | undefined,
): Record<string, unknown> | undefined {
  if (maxTokens === undefined) return undefined;
  const existing =
    payload && typeof payload.reasoning === "object" && payload.reasoning !== null
      ? (payload.reasoning as Record<string, unknown>)
      : {};
  return { ...payload, reasoning: { ...existing, max_tokens: maxTokens } };
}

/** Read the cap from the environment. Anything unreadable yields `undefined` (inert). */
function capFromEnv(): number | undefined {
  const raw = (process.env[REASONING_MAX_TOKENS_ENV] || "").trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export default function registerReasoningCap(pi: {
  on: (event: string, handler: (event: { payload?: unknown }) => unknown) => void;
}): void {
  const cap = capFromEnv();
  if (cap === undefined) return;
  pi.on("before_provider_request", (event) =>
    buildReasoningPayload((event?.payload ?? {}) as Record<string, unknown>, cap),
  );
}
