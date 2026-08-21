/**
 * Tests for OpenRouter serving-endpoint capture (EHAC-2280, AC #1).
 *
 * The whole point of this module is that it reports what actually served a run and
 * NOTHING else. Two failure modes would each be worse than having no field at all:
 *
 *  1. fabricating a value when the lookup did not succeed — a coverage record that
 *     names an endpoint nobody verified is worse than one that says "not reported";
 *  2. throwing — the lookup is observability bolted onto a review, and observability
 *     must never be able to fail the thing it observes.
 *
 * So every test here asserts BOTH directions: the populated path AND the null path,
 * with the null distinguished from a false value (`null`, never `""`, `false` or 0).
 */
import { describe, it, expect } from "bun:test";
import {
  lookupGenerationRecord,
  GENERATION_NOT_REPORTED,
  OPENROUTER_GENERATION_ATTEMPTS,
} from "../src/openrouter-generation";
import { metricFromPiRun } from "../src/review/summary";
import type { PiRunResult } from "../src/types";

/** A generation record shaped like the one CI run 32525881782 actually observed. */
const LIVE_SHAPED_RECORD = {
  data: {
    id: "gen-1787345653-ef4XewqlSkLK9gJy2Z7b",
    provider_name: "DeepInfra",
    native_tokens_reasoning: 0,
    generation_time: 1234,
    latency: 567,
    // NOTE: no `quantization` key. Confirmed live — it is not a field of this
    // endpoint. Its absence here is deliberate fixture fidelity, not an omission.
  },
};

interface StubCall {
  url: string;
  headers: Record<string, string>;
}

/** Build a fetch stub that replays a fixed script of responses, recording calls. */
function stubFetch(script: Array<{ status: number; body?: unknown } | Error>) {
  const calls: StubCall[] = [];
  let i = 0;
  const fetchStub = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body ?? {}),
    };
  };
  return { fetchStub, calls };
}

function deps(script: Array<{ status: number; body?: unknown } | Error>) {
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const { fetchStub, calls } = stubFetch(script);
  return {
    calls,
    warnings,
    sleeps,
    opts: {
      apiKey: "sk-or-v1-TESTKEY-NEVER-LOGGED",
      fetchImpl: fetchStub as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      warn: (m: string) => warnings.push(m),
    },
  };
}

/** The identity the capture is read off: pi's assistant message for an OpenRouter run. */
const OPENROUTER_RUN = { responseId: "gen-1787345653-ef4XewqlSkLK9gJy2Z7b", provider: "openrouter" };

describe("lookupGenerationRecord — the populated direction", () => {
  it("reports the endpoint that actually served the run", async () => {
    const d = deps([{ status: 200, body: LIVE_SHAPED_RECORD }]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);

    expect(rec.servingProvider).toBe("DeepInfra");
    expect(rec.nativeTokensReasoning).toBe(0);
    expect(rec.generationTimeMs).toBe(1234);
    expect(rec.latencyMs).toBe(567);
    expect(d.calls.length).toBe(1);
    expect(d.calls[0]!.url).toContain("generation?id=gen-1787345653-ef4XewqlSkLK9gJy2Z7b");
  });

  it("reports a DIFFERENT endpoint for a differently-served run (the AC #1 discriminator)", async () => {
    // The field is only evidence of routing if it can differ. Live proof is CI run
    // 32525881782 (DeepInfra vs Novita); this asserts the reader does not flatten it.
    const a = deps([{ status: 200, body: LIVE_SHAPED_RECORD }]);
    const b = deps([
      { status: 200, body: { data: { provider_name: "Novita", native_tokens_reasoning: 10 } } },
    ]);
    const one = await lookupGenerationRecord(OPENROUTER_RUN, a.opts);
    const two = await lookupGenerationRecord(OPENROUTER_RUN, b.opts);

    expect(one.servingProvider).toBe("DeepInfra");
    expect(two.servingProvider).toBe("Novita");
    expect(one.servingProvider).not.toBe(two.servingProvider);
  });

  it("survives the generation record LAGGING the stream — 404, then 200", async () => {
    // Observed in CI: the record is not available the instant the stream ends.
    const d = deps([{ status: 404 }, { status: 404 }, { status: 200, body: LIVE_SHAPED_RECORD }]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);

    expect(rec.servingProvider).toBe("DeepInfra");
    expect(d.calls.length).toBe(3);
    expect(d.sleeps.length).toBe(2);
  });

  it("never records a quantization, because the endpoint does not report one", async () => {
    const d = deps([{ status: 200, body: LIVE_SHAPED_RECORD }]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);
    expect(rec.quantization).toBeNull();
  });
});

describe("lookupGenerationRecord — the null direction (never a false value, never a throw)", () => {
  const expectNotReported = (rec: Awaited<ReturnType<typeof lookupGenerationRecord>>) => {
    // `null`, specifically. An empty string or `false` would read downstream as a
    // reported value, and the contract is that null means "not reported".
    expect(rec.servingProvider).toBeNull();
    expect(rec.nativeTokensReasoning).toBeNull();
    expect(rec.generationTimeMs).toBeNull();
    expect(rec.latencyMs).toBeNull();
    expect(rec.quantization).toBeNull();
  };

  it("returns nulls on 401 and does NOT retry a permanent rejection", async () => {
    const d = deps([{ status: 401, body: { error: { message: "No auth credentials found" } } }]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);

    expectNotReported(rec);
    expect(d.calls.length).toBe(1);
    expect(d.warnings.length).toBe(1);
  });

  it("returns nulls when the transport throws (timeout / DNS / abort)", async () => {
    const d = deps([new Error("The operation was aborted due to timeout")]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);

    expectNotReported(rec);
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it("returns nulls when the bounded retry is EXHAUSTED, and stays bounded", async () => {
    const d = deps([{ status: 404 }]); // the stub replays the last step forever
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);

    expectNotReported(rec);
    expect(d.calls.length).toBe(OPENROUTER_GENERATION_ATTEMPTS);
    expect(OPENROUTER_GENERATION_ATTEMPTS).toBeLessThanOrEqual(6);
  });

  it("returns nulls when the record comes back WITHOUT provider_name — never invents one", async () => {
    const d = deps([{ status: 200, body: { data: { id: "gen-x", native_tokens_reasoning: 3 } } }]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);

    expect(rec.servingProvider).toBeNull();
    // A record that arrived but named no provider is not evidence of anything, so
    // nothing else off it is recorded either.
    expect(rec.nativeTokensReasoning).toBeNull();
  });

  it("returns nulls when provider_name is present but empty or non-string", async () => {
    for (const bad of ["", "   ", 42, null, {}]) {
      const d = deps([{ status: 200, body: { data: { provider_name: bad } } }]);
      const rec = await lookupGenerationRecord(OPENROUTER_RUN, d.opts);
      expect(rec.servingProvider).toBeNull();
    }
  });

  it("makes ZERO network calls when there is no responseId", async () => {
    const d = deps([{ status: 200, body: LIVE_SHAPED_RECORD }]);
    const rec = await lookupGenerationRecord({ responseId: undefined, provider: "openrouter" }, d.opts);

    expectNotReported(rec);
    expect(d.calls.length).toBe(0);
    expect(d.warnings.length).toBe(0); // a non-OpenRouter-shaped run is not a problem to report
  });

  it("makes ZERO network calls for a NON-OpenRouter provider", async () => {
    const d = deps([{ status: 200, body: LIVE_SHAPED_RECORD }]);
    const rec = await lookupGenerationRecord(
      { responseId: "msg_01ABC", provider: "anthropic" },
      d.opts,
    );

    expectNotReported(rec);
    expect(d.calls.length).toBe(0);
  });

  it("makes ZERO network calls when no API key is available", async () => {
    const d = deps([{ status: 200, body: LIVE_SHAPED_RECORD }]);
    const rec = await lookupGenerationRecord(OPENROUTER_RUN, { ...d.opts, apiKey: undefined });

    expectNotReported(rec);
    expect(d.calls.length).toBe(0);
  });

  it("GENERATION_NOT_REPORTED is the shape every failure path returns", async () => {
    expect(GENERATION_NOT_REPORTED).toEqual({
      servingProvider: null,
      quantization: null,
      nativeTokensReasoning: null,
      generationTimeMs: null,
      latencyMs: null,
    });
  });
});

describe("lookupGenerationRecord — secret hygiene", () => {
  it("sends the key as a bearer header and never puts it in a warning", async () => {
    const d = deps([{ status: 401 }, new Error("boom")]);
    await lookupGenerationRecord(OPENROUTER_RUN, d.opts);
    const d2 = deps([new Error("connect ECONNREFUSED")]);
    await lookupGenerationRecord(OPENROUTER_RUN, d2.opts);

    expect(d.calls[0]!.headers.Authorization).toBe("Bearer sk-or-v1-TESTKEY-NEVER-LOGGED");
    for (const w of [...d.warnings, ...d2.warnings]) {
      expect(w).not.toContain("sk-or-v1-TESTKEY-NEVER-LOGGED");
    }
  });
});

describe("metricFromPiRun — additive spread, exactly like failureClass", () => {
  const base: PiRunResult = {
    conclusion: "success",
    output: "ok",
    turnsUsed: 3,
    providerRetries: 0,
    durationSeconds: 12.34,
    costUsd: 0.01,
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      estimated: false,
      modelLabel: "deepseek/deepseek-v4-pro",
      source: "provider",
    },
  };

  it("carries the captured endpoint into the coverage record", () => {
    const m = metricFromPiRun(
      { ...base, servingProvider: "DeepInfra", quantization: null, nativeTokensReasoning: 0 },
      "reviewer",
    );
    expect(m.servingProvider).toBe("DeepInfra");
    expect(m.quantization).toBeNull();
    expect(m.nativeTokensReasoning).toBe(0);
  });

  it("carries an honest null through, rather than dropping the field", () => {
    const m = metricFromPiRun({ ...base, servingProvider: null, quantization: null }, "reviewer");
    expect("servingProvider" in m).toBe(true);
    expect(m.servingProvider).toBeNull();
  });

  it("OMITS the fields entirely when the run never looked them up", () => {
    // An older consumer, or a non-OpenRouter provider: the record must be shaped
    // exactly as it was before this change. `version: 1` does not move.
    const m = metricFromPiRun(base, "reviewer");
    expect("servingProvider" in m).toBe(false);
    expect("quantization" in m).toBe(false);
    expect("nativeTokensReasoning" in m).toBe(false);
  });
});
