import { describe, expect, it } from "bun:test";
import { parseInputs } from "../src/github/context";
import {
  parseReasoningModes, shapeReasoningRequest, validateReasoningSchedule, parseReasoningTelemetry,
} from "../src/openrouter-reasoning";

const mimo = { id: "xiaomi/mimo-v2.5-pro", provider: "openrouter", reasoning: true };
const modes = { [mimo.id]: "enabled" as const };
const payload = { reasoning: { effort: "high", exclude: true }, messages: [], tools: [] };

describe("OpenRouter reasoning contract", () => {
  it("reads the composite INPUT mapping through the real input parser", () => {
    const name = "INPUT_OPENROUTER_MODEL_REASONING_MODES";
    const original = process.env[name];
    try {
      process.env[name] = JSON.stringify(modes);
      expect(parseInputs().openRouterReasoningModes).toEqual(modes);
      process.env[name] = "[]";
      expect(() => parseInputs()).toThrow(/openrouter_model_reasoning_modes/);
    } finally {
      if (original === undefined) delete process.env[name]; else process.env[name] = original;
    }
  });
  it("normalizes canonical keys and preserves the empty default", () => {
    expect(parseReasoningModes("")).toEqual({});
    expect(parseReasoningModes('{"openrouter/xiaomi/mimo-v2.5-pro":"enabled"}')).toEqual(modes);
  });

  it.each(['{', '[]', 'null', '"x"', '{"":"enabled"}', '{"x":"enabled"}',
    '{"a/b":"high"}', '{"a/b":true}', '{"a/b":"effort","openrouter/a/b":"enabled"}',
    '{"a/../b":"enabled"}', '{"__proto__":"enabled"}', '{"a/b":"effort","a/b":"enabled"}'])
  ("rejects malformed or ambiguous map %s before execution", (raw) => {
    expect(() => parseReasoningModes(raw)).toThrow(/openrouter_model_reasoning_modes/);
  });

  it("keeps unconfigured effort payload identity and reports the actual effort", () => {
    const result = shapeReasoningRequest(payload, { model: mimo, modes: {}, thinking: "high", requestedThinking: "high" });
    expect(result.payload).toBeUndefined();
    expect(result.reasoning).toMatchObject({ configuredMode: "effort", effectiveControl: "named-effort", effort: "high", adapted: false });
  });

  it("reports requested high as provider-default after binary adaptation", () => {
    const result = shapeReasoningRequest(payload, { model: mimo, modes, thinking: "high", requestedThinking: "high" });
    expect(result.payload).toEqual({ ...payload, reasoning: { exclude: true, enabled: true } });
    expect(result.reasoning).toEqual({ requestedThinking: "high", piThinking: "high", configuredMode: "enabled", effectiveControl: "provider-default", adapted: true });
    expect(payload.reasoning.effort).toBe("high");
  });

  it("uses one cap control in either mode", () => {
    for (const configuredModes of [{}, modes]) {
      const result = shapeReasoningRequest({ reasoning: { effort: "high", enabled: true, exclude: true } }, {
        model: mimo, modes: configuredModes, thinking: "high", requestedThinking: "high", maxTokens: 64,
      });
      expect(result.payload).toEqual({ reasoning: { exclude: true, max_tokens: 64 } });
      expect(result.reasoning).toMatchObject({ effectiveControl: "max-tokens", maxTokens: 64, adapted: true });
    }
  });

  it("omits binary off but preserves Pi's effort-mode off payload", () => {
    for (const configuredModes of [{}, modes]) {
      const original = { reasoning: { effort: "none" }, messages: [] };
      const result = shapeReasoningRequest(original, { model: mimo, modes: configuredModes, thinking: "off", requestedThinking: "off" });
      expect(result.payload).toEqual(configuredModes === modes ? { messages: [] } : undefined);
      expect(result.reasoning.effectiveControl).toBe("off");
    }
  });

  it("respects non-reasoning metadata and other providers", () => {
    for (const model of [{ ...mimo, reasoning: false }, { ...mimo, provider: "other" }]) {
      expect(shapeReasoningRequest(payload, { model, modes, thinking: "high", requestedThinking: "high" }).payload).toBeUndefined();
    }
  });

  it("rejects an off setting anywhere in the effective capped schedule", () => {
    expect(() => validateReasoningSchedule(64, ["high", "off"])).toThrow(/reasoning_max_tokens/);
    expect(() => validateReasoningSchedule(undefined, ["off"])).not.toThrow();
    expect(() => validateReasoningSchedule(64, ["high", "max"])).not.toThrow();
  });

  it("resolves independent modes from each current model without shared mutable state", () => {
    const models = [mimo, { ...mimo, id: "deepseek/deepseek-v4-pro" }, mimo];
    const results = models.map((model) => shapeReasoningRequest(payload, { model, modes, thinking: "high", requestedThinking: "high" }));
    expect(results.map((r) => r.reasoning.effectiveControl)).toEqual(["provider-default", "named-effort", "provider-default"]);
  });

  it("rejects invalid telemetry and exposes only the fixed control fields", () => {
    const record = shapeReasoningRequest(payload, { model: mimo, modes, thinking: "high", requestedThinking: "high" }).reasoning;
    const encode = (value: unknown) => `ELEK_REASONING:${JSON.stringify(value)}`;
    expect(parseReasoningTelemetry(encode({ ...record, rawReasoning: "must not escape" }))).toEqual(record);
    expect(parseReasoningTelemetry(encode({ ...record, effectiveControl: "max-tokens", maxTokens: -1 }))).toBeUndefined();
    expect(parseReasoningTelemetry(encode({ ...record, effectiveControl: "named-effort" }))).toBeUndefined();
    expect(parseReasoningTelemetry("ELEK_REASONING:{")).toBeUndefined();
  });
});
