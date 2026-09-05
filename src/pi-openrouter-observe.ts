/** Request shaping and control-only telemetry; never write to Pi's JSON stdout. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseReasoningModes, shapeReasoningRequest,
  REASONING_MAX_TOKENS_ENV, REASONING_MODES_ENV, REASONING_THINKING_ENV, REASONING_TELEMETRY_PREFIX, REASONING_NOT_APPLICABLE,
} from "./openrouter-reasoning.js";

export { buildReasoningPayload, REASONING_MAX_TOKENS_ENV } from "./openrouter-reasoning.js";

export default function registerReasoningControl(pi: ExtensionAPI): void {
  // Elek validates before spawning Pi: hook exceptions are caught by Pi and cannot
  // themselves prevent the provider request.
  const modes = parseReasoningModes(process.env[REASONING_MODES_ENV] || "");
  const rawCap = process.env[REASONING_MAX_TOKENS_ENV];
  const maxTokens = rawCap === undefined ? undefined : Number(rawCap);
  const requestedThinking = process.env[REASONING_THINKING_ENV] || "high";
  let lastTelemetry = "";
  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    if (ctx.model.provider !== "openrouter") {
      if (lastTelemetry !== REASONING_NOT_APPLICABLE) process.stderr.write(`${REASONING_NOT_APPLICABLE}\n`);
      lastTelemetry = REASONING_NOT_APPLICABLE;
      return;
    }
    const shaped = shapeReasoningRequest(event.payload as Record<string, unknown>, {
      model: ctx.model, modes, maxTokens, requestedThinking, thinking: ctx.thinkingLevel ?? "off",
    });
    const telemetry = JSON.stringify(shaped.reasoning);
    if (telemetry !== lastTelemetry) {
      process.stderr.write(`${REASONING_TELEMETRY_PREFIX}${telemetry}\n`);
      lastTelemetry = telemetry;
    }
    return shaped.payload;
  });
}
