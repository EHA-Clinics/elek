/**
 * OpenRouter provider-routing passthrough (EHAC-2280, AC #2).
 *
 * elek has no OpenRouter HTTP client — it spawns the `pi` CLI and reads a JSON
 * event stream — so there is no request body here to thread a `provider` object
 * into. pi's own surface is used instead: `models.json` ->
 * `providers.openrouter.modelOverrides[<model>].compat.openRouterRouting`, which
 * pi documents as "sent as-is in the `provider` field of the OpenRouter API
 * request" (`docs/models.md:458`).
 *
 * That route was verified empirically before this module was written (T1 spike,
 * `260821-t38-SPIKE-FINDINGS.md`): with the override configured, the outgoing
 * payload carried a `provider` object deep-equal to it — observed BOTH at pi's
 * `before_provider_request` hook and independently at the receiving server. Without
 * it, no `provider` key was present. `PI_OFFLINE=1`, which elek forces, does not
 * suppress `models.json` merging.
 *
 * WHY THE PARSER FAILS CLOSED. This input can only ever loosen or misdirect
 * routing, and its effect is invisible in the logs: a malformed or misspelled value
 * yields a perfectly green run with the guardrail silently absent. That is the
 * failure mode `parseStallTimeoutSecondsInput` already refuses for the watchdog, for
 * the same reason. A configuration error must be reported before any model runs.
 *
 * DELIBERATELY NOT SUPPORTED: `order` + `allow_fallbacks: false` endpoint pinning.
 * It converts a latency problem into an availability problem and OpenRouter advises
 * against it. `order` remains in the allowlist because it is a documented routing
 * key and callers may have a considered reason; nothing here encourages it.
 */

/**
 * The thirteen documented OpenRouter provider-routing keys.
 * https://openrouter.ai/docs/guides/routing/provider-selection
 */
export const OPENROUTER_ROUTING_KEYS = [
  "order",
  "allow_fallbacks",
  "require_parameters",
  "data_collection",
  "only",
  "ignore",
  "quantizations",
  "sort",
  "max_price",
  "preferred_min_throughput",
  "preferred_max_latency",
  "zdr",
  "enforce_distillable_text",
] as const;

const ALLOWED = new Set<string>(OPENROUTER_ROUTING_KEYS);

/**
 * Parse `openrouter_provider_preferences`, failing closed.
 *
 * An EMPTY value is not a misconfiguration — it is the documented default, and the
 * documented default is "send nothing", i.e. exactly today's behaviour.
 *
 * @throws {Error} on unparseable JSON, on a non-object, or on any key outside the
 *   documented routing allowlist.
 */
export function parseOpenRouterProviderPreferences(
  value: string,
): Record<string, unknown> | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (err) {
    throw new Error(
      `Invalid openrouter_provider_preferences input: not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }). Refusing to run: a routing policy that cannot be parsed would leave the review with no ` +
        "guardrail at all, behind a green log line.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid openrouter_provider_preferences input: expected a JSON OBJECT of routing preferences, ` +
        `got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}.`,
    );
  }

  const unknown = Object.keys(parsed as Record<string, unknown>).filter((k) => !ALLOWED.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid openrouter_provider_preferences input: unsupported key(s) ${unknown
        .map((k) => `"${k}"`)
        .join(", ")}. ` +
        `Only the documented OpenRouter routing keys are accepted: ${OPENROUTER_ROUTING_KEYS.join(", ")}. ` +
        "This object is sent verbatim in the provider field of the OpenRouter request, so an " +
        "unrecognised key is either a typo or a sampling parameter that does not belong here.",
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Build the `models.json` document pi will merge.
 *
 * Always serialises the PARSED value. Interpolating the raw input string would let a
 * caller smuggle arbitrary structure past the allowlist that just validated it.
 */
export function buildModelsJson(
  model: string,
  preferences: Record<string, unknown>,
): Record<string, unknown> {
  return {
    providers: {
      openrouter: {
        modelOverrides: {
          // Keyed by the model id exactly as elek passes it to `pi --model`; elek's
          // model strings are provider-qualified slugs, which is the form the spike
          // exercised.
          [model]: { compat: { openRouterRouting: preferences } },
        },
      },
    },
  };
}

/**
 * Write the routing config into a private agent dir under `tmpDir`, returning that
 * dir so the caller can point `PI_CODING_AGENT_DIR` at it.
 *
 * Returns `undefined` — writing nothing — when preferences are unset, so an
 * unconfigured caller keeps today's config resolution byte for byte.
 *
 * A pre-existing agent dir is never written into or mutated: a fresh, private dir is
 * used instead. The caller is expected to warn when it is bypassing an explicitly
 * configured one.
 */
export function writeRoutingConfig(
  tmpDir: string,
  model: string,
  preferences: Record<string, unknown> | undefined,
  _existingAgentDir?: string,
): string | undefined {
  if (!preferences) return undefined;
  // Imported lazily so this module stays trivially unit-testable and free of
  // import-time side effects.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");

  const agentDir = join(tmpDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(buildModelsJson(model, preferences), null, 2),
    "utf-8",
  );
  return agentDir;
}
