/**
 * Tests for the OpenRouter provider-routing passthrough (EHAC-2280, AC #2).
 *
 * `openrouter_provider_preferences` is the FIRST JSON-valued input among elek's
 * inputs, and it is the only one whose effect is invisible in the logs — a
 * malformed or misdirected value produces a perfectly green run with the guardrail
 * silently absent. That is why the parser fails CLOSED on everything it does not
 * recognise, and why every rejection is covered here.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseOpenRouterProviderPreferences,
  buildModelsJson,
  writeRoutingConfig,
  OPENROUTER_ROUTING_KEYS,
} from "../src/openrouter-routing";

describe("parseOpenRouterProviderPreferences", () => {
  it("treats an empty value as 'send nothing' — today's behaviour", () => {
    expect(parseOpenRouterProviderPreferences("")).toBeUndefined();
    expect(parseOpenRouterProviderPreferences("   ")).toBeUndefined();
  });

  it("round-trips a well-formed object of allowlisted keys", () => {
    const raw = '{"allow_fallbacks":true,"quantizations":["fp8"],"sort":{"by":"throughput"}}';
    expect(parseOpenRouterProviderPreferences(raw)).toEqual({
      allow_fallbacks: true,
      quantizations: ["fp8"],
      sort: { by: "throughput" },
    });
  });

  it("parses the exact value eha_care will ship", () => {
    const raw =
      '{"preferred_min_throughput":{"p90":20},"quantizations":["fp16","bf16","fp8"],"allow_fallbacks":true}';
    const parsed = parseOpenRouterProviderPreferences(raw);
    expect(parsed).toEqual({
      preferred_min_throughput: { p90: 20 },
      quantizations: ["fp16", "bf16", "fp8"],
      allow_fallbacks: true,
    });
  });

  it("throws on unparseable JSON", () => {
    expect(() => parseOpenRouterProviderPreferences("{not json")).toThrow(
      /openrouter_provider_preferences/,
    );
  });

  it.each(["[]", '"x"', "null", "42", "true"])("throws on the non-object %p", (raw) => {
    expect(() => parseOpenRouterProviderPreferences(raw)).toThrow(
      /openrouter_provider_preferences/,
    );
  });

  it("throws on a key outside the documented routing allowlist, naming it", () => {
    expect(() => parseOpenRouterProviderPreferences('{"temperature":0}')).toThrow(/temperature/);
    expect(() => parseOpenRouterProviderPreferences('{"allow_fallbacks":true,"max_tokens":10}')).toThrow(
      /max_tokens/,
    );
  });

  it("allows exactly the thirteen documented OpenRouter routing keys", () => {
    expect(OPENROUTER_ROUTING_KEYS.length).toBe(13);
    for (const key of OPENROUTER_ROUTING_KEYS) {
      expect(() => parseOpenRouterProviderPreferences(JSON.stringify({ [key]: true }))).not.toThrow();
    }
  });
});

describe("buildModelsJson", () => {
  it("nests the parsed object under providers.openrouter.modelOverrides[model].compat.openRouterRouting", () => {
    const prefs = { allow_fallbacks: true, quantizations: ["fp8"] };
    const doc = buildModelsJson("deepseek/deepseek-v4-pro", prefs) as any;
    expect(doc.providers.openrouter.modelOverrides["deepseek/deepseek-v4-pro"].compat.openRouterRouting).toEqual(
      prefs,
    );
  });

  // The serializer must emit the PARSED value, never the raw input string. Interpolating
  // the raw string into the file would let a caller inject arbitrary JSON structure past
  // the allowlist that just validated it.
  it("emits the parsed value, so nothing outside the allowlist can survive round-tripping", () => {
    const prefs = parseOpenRouterProviderPreferences('{"allow_fallbacks":true}')!;
    const text = JSON.stringify(buildModelsJson("m", prefs));
    expect(text).toContain('"allow_fallbacks":true');
    expect(JSON.parse(text)).toBeTruthy();
  });
});

describe("writeRoutingConfig", () => {
  it("writes nothing and returns undefined when preferences are unset", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elek-routing-"));
    try {
      expect(writeRoutingConfig(tmp, "m", undefined)).toBeUndefined();
      expect(existsSync(join(tmp, "pi-agent", "models.json"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes models.json under the temp dir and returns the agent dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elek-routing-"));
    try {
      const dir = writeRoutingConfig(tmp, "deepseek/deepseek-v4-pro", { allow_fallbacks: true });
      expect(dir).toBe(join(tmp, "pi-agent"));
      const doc = JSON.parse(readFileSync(join(dir!, "models.json"), "utf-8"));
      expect(
        doc.providers.openrouter.modelOverrides["deepseek/deepseek-v4-pro"].compat.openRouterRouting,
      ).toEqual({ allow_fallbacks: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not write into, or mutate, a pre-existing agent dir supplied by the caller", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elek-routing-"));
    const existing = join(tmp, "their-agent-dir");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "models.json"), '{"providers":{"anthropic":{"baseUrl":"x"}}}', "utf-8");
    try {
      const dir = writeRoutingConfig(tmp, "m", { allow_fallbacks: true }, existing);
      expect(dir).toBe(join(tmp, "pi-agent"));
      // Their file is untouched.
      expect(JSON.parse(readFileSync(join(existing, "models.json"), "utf-8"))).toEqual({
        providers: { anthropic: { baseUrl: "x" } },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
