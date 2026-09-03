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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "node:url";
import {
  parseOpenRouterProviderPreferences,
  buildModelsJson,
  writeRoutingConfig,
  modelSlug,
  OPENROUTER_ROUTING_KEYS,
} from "../src/openrouter-routing";
import {
  buildReasoningPayload,
} from "../src/pi-openrouter-observe";
import { parseReasoningMaxTokensInput } from "../src/github/context";

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
  it("runs under the Node ESM loader used by the composite action", () => {
    const moduleUrl = pathToFileURL(resolve("src/openrouter-routing.ts")).href;
    const program = `
      import { existsSync, mkdtempSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import { writeRoutingConfig } from ${JSON.stringify(moduleUrl)};

      const tmp = mkdtempSync(join(tmpdir(), "elek-routing-esm-"));
      try {
        const dir = writeRoutingConfig(tmp, "deepseek/deepseek-v4-pro", { allow_fallbacks: true });
        if (!dir || !existsSync(join(dir, "models.json"))) process.exitCode = 2;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    `;
    const result = spawnSync(
      "node",
      ["--import", "tsx", "--input-type=module", "--eval", program],
      { encoding: "utf8" },
    );

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

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
      expect(dir).toBe(join(tmp, "pi-agent", "deepseek-deepseek-v4-pro"));
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
      expect(dir).toBe(join(tmp, "pi-agent", "m"));
      // Their file is untouched.
      expect(JSON.parse(readFileSync(join(existing, "models.json"), "utf-8"))).toEqual({
        providers: { anthropic: { baseUrl: "x" } },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * EHAC-2294 — THE REGRESSION THIS FILE EXISTS FOR.
   *
   * A council runs its reviewer lenses concurrently, and each lens calls
   * writeRoutingConfig with ITS OWN model. While every lens shared one `pi-agent`
   * directory, they raced to write a single `models.json` whose `modelOverrides` holds
   * exactly one key — last writer won and every other lens ran with NO `provider`
   * object, silently, while the input still echoed correctly in the workflow log.
   *
   * Measured on eha_care before the fix: the one lens on `deepseek-v4-flash` kept being
   * served by an endpoint the caller had explicitly put in `ignore`.
   */
  it("gives each model its own agent dir, so concurrent lenses cannot clobber each other", () => {
    const tmp = mkdtempSync(join(tmpdir(), "elek-routing-"));
    try {
      const prefs = { ignore: ["digitalocean"] };
      const models = [
        "deepseek/deepseek-v4-pro",
        "xiaomi/mimo-v2.5-pro",
        "deepseek/deepseek-v4-flash",
      ];
      // Interleaved exactly as Promise.all would: every lens writes before any reads.
      const dirs = models.map((m) => writeRoutingConfig(tmp, m, prefs)!);

      expect(new Set(dirs).size).toBe(models.length);

      // EVERY model still has its own routing after all the writes have landed.
      for (const [i, m] of models.entries()) {
        const doc = JSON.parse(readFileSync(join(dirs[i], "models.json"), "utf-8"));
        const overrides = doc.providers.openrouter.modelOverrides;
        expect(Object.keys(overrides)).toEqual([m]);
        expect(overrides[m].compat.openRouterRouting).toEqual(prefs);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: a shared directory really would have lost all but one model", () => {
    // Proves the test above is not vacuous — with the slug removed, the three writes
    // collapse onto one path and only the last model survives.
    const tmp = mkdtempSync(join(tmpdir(), "elek-routing-"));
    try {
      const shared = join(tmp, "pi-agent");
      mkdirSync(shared, { recursive: true });
      for (const m of ["a/one", "b/two", "c/three"]) {
        writeFileSync(join(shared, "models.json"), JSON.stringify(buildModelsJson(m, {})), "utf-8");
      }
      const doc = JSON.parse(readFileSync(join(shared, "models.json"), "utf-8"));
      expect(Object.keys(doc.providers.openrouter.modelOverrides)).toEqual(["c/three"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("modelSlug makes a provider-qualified id safe as a single directory segment", () => {
    expect(modelSlug("deepseek/deepseek-v4-pro")).toBe("deepseek-deepseek-v4-pro");
    // A dot is legal INSIDE a slug — real model ids carry one.
    expect(modelSlug("xiaomi/mimo-v2.5-pro")).toBe("xiaomi-mimo-v2.5-pro");
    expect(modelSlug("")).toBe("model");

    // The property that actually matters: whatever the input, the agent dir stays
    // INSIDE its parent. Asserted by resolution, not by inspecting the string.
    for (const hostile of ["a/../../etc/passwd", "..", "../..", "/", "...", "./."]) {
      const resolved = resolve(join("/base", "pi-agent", modelSlug(hostile)));
      expect(resolved.startsWith(resolve("/base", "pi-agent") + "/")).toBe(true);
    }
  });
});

/**
 * EHAC-2280 step 4 (R-4) — `reasoning_max_tokens`.
 *
 * Shipped UNSET and set by nobody. Two facts make that the only responsible default,
 * and both are asserted rather than asserted-about: pi exposes no `reasoning.max_tokens`
 * config knob (its `modelOverrides.reasoning` is a boolean capability flag), so this can
 * only reach the wire through `before_provider_request`; and pi's `Usage` reports no
 * reasoning tokens, so elek CANNOT currently measure whether such a cap ever binds.
 */
describe("reasoning_max_tokens", () => {
  it("treats an empty value as unset", () => {
    expect(parseReasoningMaxTokensInput("")).toBeUndefined();
    expect(parseReasoningMaxTokensInput("  ")).toBeUndefined();
  });

  it("parses a well-formed value", () => {
    expect(parseReasoningMaxTokensInput("32000")).toBe(32000);
  });

  it.each(["0", "-1", "abc", "1e5", "32000.5", "32_000"])(
    "throws on %p, naming the input",
    (bad) => {
      expect(() => parseReasoningMaxTokensInput(bad)).toThrow(/reasoning_max_tokens/);
    },
  );

  // The shipped default must be a STRICT no-op. Asserting merely "max_tokens is absent"
  // would still pass if the handler rebuilt and replaced the payload while changing
  // nothing — which is a different thing, and the difference is visible to every later
  // handler in pi's extension chain. So this asserts at reference level.
  it("is a STRICT no-op when unset — returns undefined, not a rebuilt payload", () => {
    const payload = { model: "m", reasoning: { effort: "high" }, messages: [] };
    expect(buildReasoningPayload(payload, undefined)).toBeUndefined();
  });

  it("preserves every pre-existing reasoning key when set", () => {
    const payload = { model: "m", reasoning: { effort: "high" }, messages: [] };
    const capped = buildReasoningPayload(payload, 32000) as any;
    // Replacing the reasoning object instead of spreading it is the likely mistake, and
    // it would silently drop review depth to the provider default.
    expect(capped.reasoning.effort).toBe("high");
    expect(capped.reasoning.max_tokens).toBe(32000);
    expect(capped.model).toBe("m");
  });

  it("does not mutate the payload it was given", () => {
    const payload = { model: "m", reasoning: { effort: "high" } };
    buildReasoningPayload(payload, 32000);
    expect(payload).toEqual({ model: "m", reasoning: { effort: "high" } });
  });

  it("adds a reasoning object when the payload had none", () => {
    const capped = buildReasoningPayload({ model: "m" }, 1000) as any;
    expect(capped.reasoning).toEqual({ max_tokens: 1000 });
  });
});
