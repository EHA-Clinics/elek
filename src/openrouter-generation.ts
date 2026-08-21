/**
 * OpenRouter serving-endpoint capture (EHAC-2280, AC #1).
 *
 * WHAT THIS ANSWERS. A council run says it ran `deepseek/deepseek-v4-pro`. It does
 * not say WHICH of that model's seventeen OpenRouter endpoints actually served it,
 * and those endpoints differ by an order of magnitude in latency. Without this
 * field, "the review timed out" and "the review was routed somewhere slow" are the
 * same observation, and routing policy cannot be evaluated at all.
 *
 * THE CHAIN, proven end to end rather than assumed. Every link was observed live in
 * elek CI run 32525881782 (`.planning/…/260821-t38-SPIKE-FINDINGS.md`, ADDENDUM):
 *
 *   1. OpenRouter puts a generation id on every streamed chunk
 *      — observed: `gen-1787345653-ef4XewqlSkLK9gJy2Z7b`.
 *   2. pi captures it: `pi-ai/dist/api/openai-completions.js:311` does
 *      `output.responseId ||= chunk.id`, and the OpenRouter provider is built on
 *      `openAICompletionsApi()` (`pi-ai/dist/providers/openrouter.js:20`), so this
 *      is the code path OpenRouter runs through — not a neighbouring one.
 *   3. pi publishes it on the assistant message as `responseId`
 *      (`pi-ai/dist/types.d.ts:295`), which elek already parses out of pi's JSON
 *      stream and, until this module existed, discarded.
 *   4. `GET /api/v1/generation?id=<id>` returns `provider_name` — observed
 *      `DeepInfra` and `Novita`, http 200. It 401s unauthenticated.
 *
 * The AC #1 positive control also held live: two runs pinned to different endpoints
 * reported DIFFERENT `provider_name`. A field that is captured but cannot vary is
 * not evidence of routing; this one varies.
 *
 * WHY THIS CAN NEVER FAIL A REVIEW. It is observability bolted onto a review, and
 * observability that can fail the thing it observes is a liability. Every error path
 * — no key, wrong provider, 401, timeout, exhausted retry, absent field — resolves
 * to `null`. `null` means "not reported": never a pass, never a failure, and never a
 * fabricated endpoint name. Nothing here throws and nothing here is unbounded.
 *
 * WHY THE RETRY IS BOUNDED AND NECESSARY. The generation record LAGS the stream —
 * observed in CI, where the probe needed several attempts before the endpoint
 * answered 200. So a single immediate lookup would systematically report `null` and
 * look like "the mechanism does not work". The retry is capped, sleeps a fixed
 * interval, and only ever retries the two statuses that can plausibly clear.
 */

/** What one lookup can report. Every field is nullable and null means "not reported". */
export interface OpenRouterGenerationRecord {
  /** The OpenRouter endpoint that actually served the run, e.g. "DeepInfra". */
  servingProvider: string | null;
  /**
   * ALWAYS null, and typed that way so no caller can start populating it by accident.
   *
   * Quantization is NOT a field of `GET /api/v1/generation?id=` — confirmed live
   * against the real endpoint, not inferred from documentation. It is published per
   * ENDPOINT on the public `/api/v1/models/{author}/{slug}/endpoints` listing, so the
   * only route to it is an offline join once `servingProvider` is known.
   *
   * It CAN be CONSTRAINED on the request side via `provider.quantizations` — see
   * `src/openrouter-routing.ts`. Constraining what MAY serve a request is not the
   * same fact as recording what DID, and this field must never be inferred from it.
   */
  quantization: null;
  /**
   * Reasoning tokens the provider actually billed for this generation.
   *
   * This is the measurement elek otherwise lacks: pi's own `Usage` reports no
   * reasoning-token count, so before this field existed there was no way to tell
   * whether a reasoning cap would ever bind. Observed live at 0 (DeepInfra) and 10
   * (Novita) on the same prompt — i.e. it is endpoint-dependent, which is precisely
   * why sizing a cap from benchmark prose rather than from this number is guesswork.
   */
  nativeTokensReasoning: number | null;
  /** Provider-reported generation time, milliseconds. */
  generationTimeMs: number | null;
  /** Provider-reported time to first token, milliseconds. */
  latencyMs: number | null;
}

/** The single shape every non-reporting path returns. Frozen so it cannot be mutated. */
export const GENERATION_NOT_REPORTED: OpenRouterGenerationRecord = Object.freeze({
  servingProvider: null,
  quantization: null,
  nativeTokensReasoning: null,
  generationTimeMs: null,
  latencyMs: null,
}) as OpenRouterGenerationRecord;

/**
 * Attempts, INCLUDING the first. Sized from the CI probe, where the record was not
 * immediately available; 6 attempts at 2s is ~10s of added settlement in the worst
 * case, against a per-run budget of 900s.
 */
export const OPENROUTER_GENERATION_ATTEMPTS = 6;
export const OPENROUTER_GENERATION_RETRY_MS = 2_000;
/** Per-attempt transport deadline, so a hung socket cannot outlive the retry budget. */
export const OPENROUTER_GENERATION_TIMEOUT_MS = 5_000;

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/**
 * Statuses worth one more attempt.
 *
 * 404 is the LAG case and the reason this retries at all: the generation record does
 * not exist yet the instant the stream closes. 5xx is ordinary transient server
 * trouble. Everything else — notably 401 and 403 — will fail identically next time,
 * so retrying it only burns wall clock before reporting the same null.
 */
const RETRYABLE_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

/** The identity a lookup is keyed on, read off pi's assistant message. */
export interface GenerationLookupSubject {
  /** pi's `AssistantMessage.responseId` — for OpenRouter, the generation id. */
  responseId?: string;
  /** pi's `AssistantMessage.provider` — the provider that actually served the run. */
  provider?: string;
}

export interface GenerationLookupOptions {
  apiKey?: string;
  baseUrl?: string;
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Injected for tests. Production passes nothing and gets the platform versions. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Does this run have a serving endpoint that can be looked up at all?
 *
 * Exported because the CALLER needs the same answer for a different reason: it draws
 * the line between ABSENT (never applicable — a non-OpenRouter run, whose coverage
 * record must be shaped exactly as it was before this feature existed) and NULL (the
 * lookup applied and could not report). Collapsing those two would put a null in
 * every Anthropic review's record and make "not reported" indistinguishable from
 * "not applicable".
 */
export function isGenerationLookupApplicable(
  subject: GenerationLookupSubject,
  apiKey: string | undefined,
): boolean {
  return (
    nonEmptyStringOrNull(subject.responseId) !== null &&
    subject.provider === "openrouter" &&
    Boolean(apiKey)
  );
}

/**
 * Look up which OpenRouter endpoint served a run.
 *
 * @returns a record whose fields are populated ONLY on a successful, authenticated
 *   lookup that actually named a provider. Every other outcome — including every
 *   error — returns `GENERATION_NOT_REPORTED`. This function does not throw.
 */
export async function lookupGenerationRecord(
  subject: GenerationLookupSubject,
  options: GenerationLookupOptions = {},
): Promise<OpenRouterGenerationRecord> {
  const {
    apiKey,
    baseUrl = OPENROUTER_API_BASE,
    attempts = OPENROUTER_GENERATION_ATTEMPTS,
    retryDelayMs = OPENROUTER_GENERATION_RETRY_MS,
    timeoutMs = OPENROUTER_GENERATION_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    warn = (m: string) => console.warn(m),
  } = options;

  // Silent skips, all three. None of these is a problem worth a log line: they are
  // the ordinary shape of a run this lookup does not apply to. Warning on them would
  // put a line in every Anthropic review's log for no reader's benefit.
  //
  // The provider gate is read from pi's own `AssistantMessage.provider` rather than
  // guessed from the id format. Matching `/^gen-/` would be inferring a vendor's id
  // scheme, and would break silently the day it changes.
  const responseId = nonEmptyStringOrNull(subject.responseId);
  if (!isGenerationLookupApplicable(subject, apiKey) || !responseId || !fetchImpl) {
    return GENERATION_NOT_REPORTED;
  }

  const url = `${baseUrl}/generation?id=${encodeURIComponent(responseId)}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status: number | undefined;
    try {
      // AbortSignal.timeout is not assumed present — this also runs under bun and
      // under whatever Node the runner image ships.
      const signal =
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        ...(signal ? { signal } : {}),
      });
      status = res.status;

      if (status === 200) {
        const body = (await res.json()) as { data?: Record<string, unknown> } | null;
        const data = body?.data;
        const servingProvider = nonEmptyStringOrNull(data?.provider_name);
        if (!servingProvider) {
          // A record arrived and named nobody. Reporting the other fields off it
          // would be reporting metrics for an endpoint we cannot identify, so the
          // whole record degrades to "not reported" together.
          warn(
            `::warning::OpenRouter generation record for ${responseId} carried no provider_name; ` +
              "recording the serving endpoint as null (not reported).",
          );
          return GENERATION_NOT_REPORTED;
        }
        return {
          servingProvider,
          quantization: null,
          nativeTokensReasoning: finiteNumberOrNull(data?.native_tokens_reasoning),
          generationTimeMs: finiteNumberOrNull(data?.generation_time),
          latencyMs: finiteNumberOrNull(data?.latency),
        };
      }

      if (!RETRYABLE_STATUSES.has(status) || attempt === attempts) {
        // The status is deliberately the ONLY thing echoed. The response body of a
        // 4xx from an authenticated endpoint is exactly where a credential would
        // leak back into a log.
        warn(
          `::warning::OpenRouter generation lookup for ${responseId} returned http ${status} ` +
            `after ${attempt} attempt(s); recording the serving endpoint as null (not reported).`,
        );
        return GENERATION_NOT_REPORTED;
      }
    } catch (err) {
      // Transport-level failure: timeout, abort, DNS, socket reset. Bounded like any
      // other retryable outcome, and terminal once the budget is spent.
      //
      // This catch is deliberately broad. It also absorbs a defect in the parsing
      // above — surfaced by mutation M3 while proving these tests can fail — which
      // costs the full retry budget before reporting null. That trade is taken on
      // purpose: this is observability, and a null costs a missing field, whereas an
      // escaping exception would fail the review it is only meant to describe.
      if (attempt === attempts) {
        warn(
          `::warning::OpenRouter generation lookup for ${responseId} failed after ${attempt} ` +
            `attempt(s): ${err instanceof Error ? err.message : String(err)}. ` +
            "Recording the serving endpoint as null (not reported).",
        );
        return GENERATION_NOT_REPORTED;
      }
    }

    await sleep(retryDelayMs);
  }

  return GENERATION_NOT_REPORTED;
}
