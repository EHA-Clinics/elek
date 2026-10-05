// Pair the verified large-input roster with output headroom. Pi's catalog permits
// ~944K output tokens and clamps against chars/4; native code tokenization can
// consume that estimate's safety reserve. 128K retains MiMo's existing ceiling
// and leaves the remaining context for complete source and tool interactions.
const MODELS = new Set([
  "z-ai/glm-5.3-flash", "xiaomi/mimo-v2.5-pro",
  "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro-0813",
]);

export function councilOutputLimit(provider: string, model: string): number | undefined {
  return provider === "openrouter" && MODELS.has(model.replace(/^openrouter\//, "")) ? 131072 : undefined;
}

/** Preserve smaller limits, source, tools and reasoning; only bound output. */
export function boundCouncilOutput(
  payload: Record<string, unknown>, model: { provider: string; id: string },
): Record<string, unknown> | undefined {
  const limit = councilOutputLimit(model.provider, model.id);
  if (limit === undefined) return undefined;
  const fields = ["max_tokens", "max_completion_tokens"].filter((key) => key in payload);
  if (!fields.length) return { ...payload, max_tokens: limit };
  const bounded = { ...payload };
  let changed = false;
  for (const key of fields) {
    if (typeof payload[key] !== "number" || !Number.isSafeInteger(payload[key]) || Number(payload[key]) <= 0 || Number(payload[key]) > limit) {
      bounded[key] = limit;
      changed = true;
    }
  }
  return changed ? bounded : undefined;
}
