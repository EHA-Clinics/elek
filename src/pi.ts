/**
 * pi CLI runner — spawns pi in JSON mode for streaming progress updates.
 * Calls back on progress events so the orchestrator can update the tracking comment
 * step-by-step, matching the progressive checklist UX users expect.
 *
 * Event format verified against the lockfile-pinned pi 0.84.2:
 *   - {"type":"session", id, version, ...}                 first line, session header
 *   - {"type":"agent_start"} | {"type":"agent_end", messages:[...]}
 *   - {"type":"turn_start"} | {"type":"turn_end", message, toolResults}
 *   - {"type":"message_start", message} | {"type":"message_end", message}
 *   - {"type":"message_update", message, assistantMessageEvent:{type, ...}}
 *       assistantMessageEvent.type ∈ text_start|text_delta|text_end|
 *                                    thinking_start|thinking_delta|thinking_end|
 *                                    toolcall_start|toolcall_delta|toolcall_end|done|error
 *   - {"type":"tool_execution_start", toolCallId, toolName, args}
 *   - {"type":"tool_execution_update", ...partialResult}
 *   - {"type":"tool_execution_end", toolCallId, toolName, result, isError}
 *
 * Final assistant text comes from agent_end.messages — the last assistant message's
 * `content` array filtered for {type:"text"} entries. Streaming text_delta events
 * are used only for progress signaling; they would over-aggregate across turns.
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { writeRoutingConfig } from "./openrouter-routing.js";
import { lookupGenerationRecord, isGenerationLookupApplicable } from "./openrouter-generation.js";
import {
  REASONING_MAX_TOKENS_ENV, REASONING_MODES_ENV, REASONING_THINKING_ENV, REASONING_TELEMETRY_PREFIX, REASONING_NOT_APPLICABLE,
  parseReasoningTelemetry, piThinkingLevel, validateReasoningSchedule,
  type ReasoningTelemetry,
} from "./openrouter-reasoning.js";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import type {
  ActionInputs,
  PiFailureClass,
  PiRunResult,
  PiTerminationReason,
} from "./types";
import { estimateRunCost, modelLabelFor, resolveRates, type ReviewCost } from "./review/cost";

const REVIEW_SYSTEM_PROMPT = [
  "You are Elek, a noninteractive read-only CI pull-request reviewer.",
  "Find only concrete, consequential issues rooted in changed code.",
  "Use repository inspection tools only to resolve a specific uncertainty required to validate a candidate finding; a self-contained change may require no tool calls.",
  "Do not edit files, ask questions, narrate research, or continue exploring after every candidate is either verified or rejected.",
  "Return the requested review format immediately when the review is complete, including when there are no findings.",
].join(" ");

export interface ProgressEvent {
  type: "thinking" | "tool_start" | "tool_end" | "text" | "done";
  detail?: string;
}

interface PiTextContent { type: "text"; text: string }
interface PiThinkingContent { type: "thinking"; thinking: string }
interface PiToolCall { type: "toolCall"; toolName?: string }
type PiContent = PiTextContent | PiThinkingContent | PiToolCall | { type: string; [k: string]: unknown };

interface PiAssistantMessage {
  role: "assistant";
  content: PiContent[];
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
  /**
   * Which provider actually served this message. pi publishes it on every assistant
   * message (`pi-ai/dist/types.d.ts:292`); elek reads it to decide whether the
   * OpenRouter generation lookup applies at all, rather than guessing from the id.
   */
  provider?: string;
  /**
   * The upstream response id, when the API exposes one. For OpenRouter this is the
   * `gen-…` generation id — `openai-completions.js:311` does
   * `output.responseId ||= chunk.id`, and the OpenRouter provider is built on that
   * exact api (`providers/openrouter.js:20`). elek parsed this field out of pi's
   * stream and discarded it until EHAC-2280; it is the key to who served the run.
   */
  responseId?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: {
    total?: number;
    input?: number;
    output?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Find the pi binary path. Checks common locations.
 */
function findPiBinary(): string {
  if (process.env.PI_EXECUTABLE && existsSync(process.env.PI_EXECUTABLE)) {
    return process.env.PI_EXECUTABLE;
  }

  const candidates = [
    `${process.env.GITHUB_ACTION_PATH || ""}/node_modules/.bin/pi`,
    `${process.env.HOME || "/root"}/.local/bin/pi`,
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];

  for (const path of candidates) {
    if (path && existsSync(path)) {
      console.log(`Found pi at: ${path}`);
      return path;
    }
  }

  console.log("pi not found at known paths, using PATH lookup");
  return "pi";
}

/**
 * HTTP statuses that a single retry on the SAME model can plausibly clear.
 * 529 is Anthropic's overloaded status; the rest are standard.
 */
const TRANSIENT_PROVIDER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** HTTP statuses that mean the request will fail identically next time. */
const PERMANENT_PROVIDER_STATUSES = new Set([400, 401, 402, 403, 404, 405, 413, 422]);

/**
 * Map a STRUCTURED provider status onto a failure class.
 *
 * Numbers only, deliberately. A provider "code" is often a string slug
 * (`rate_limit_exceeded`, `insufficient_quota`) whose vocabulary is undocumented
 * and provider-specific, and matching those — or worse, matching the sanitized
 * message text — is how retry policy silently starts firing on the wrong thing.
 * Anything unrecognised returns undefined, which the caller turns into
 * `unknown`, which is never retried.
 */
export function classifyProviderStatus(status: unknown): PiFailureClass | undefined {
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  if (TRANSIENT_PROVIDER_STATUSES.has(status)) return "provider_transient";
  if (PERMANENT_PROVIDER_STATUSES.has(status)) return "provider_permanent";
  if (status >= 500 && status <= 599) return "provider_transient";
  if (status >= 400 && status <= 499) return "provider_permanent";
  return undefined;
}

/** The fixed key set searched for a numeric HTTP status on a structured error object. */
const PROVIDER_STATUS_KEYS = ["status", "statusCode", "httpStatus", "http_status", "code"] as const;

function numericStatusOn(container: unknown): number | undefined {
  if (!container || typeof container !== "object") return undefined;
  const record = container as Record<string, unknown>;
  for (const key of PROVIDER_STATUS_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

/**
 * Pull a numeric provider status out of a parsed pi stream event.
 *
 * The searched paths are a CLOSED list of structured containers. If pi ever
 * moves the field, this returns undefined and the run classifies as `unknown` —
 * it fails closed (no retry) rather than guessing.
 */
export function providerStatusFromEvent(event: unknown): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, any>;
  const candidates: unknown[] = [
    e.error,
    e.providerError,
    e.assistantMessageEvent?.error,
    e.message?.error,
    e.result?.error,
    e.type === "error" ? e : undefined,
  ];
  for (const candidate of candidates) {
    const status = numericStatusOn(candidate);
    if (status !== undefined) return status;
  }
  return undefined;
}

export interface ProviderErrorEnvelope {
  status: number;
  ineligibilityReasons: string[];
}

function sanitizeProviderReason(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128);
}

/**
 * Parse pi's exact `<status>: <JSON object>` provider-error envelope.
 *
 * The full-string anchor, integer body code, and prefix/body agreement are all
 * load-bearing. They let elek recover structured state that pi serialized into
 * `errorMessage` without teaching retry policy to guess from provider prose.
 */
export function providerErrorFromMessage(message: unknown): ProviderErrorEnvelope | undefined {
  if (typeof message !== "string") return undefined;
  const match = /^\s*(\d{3}):\s*(\{[\s\S]*\})\s*$/.exec(message);
  if (!match) return undefined;

  const status = Number(match[1]);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[2]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (!Number.isInteger(body.code) || body.code !== status) return undefined;

  const metadata = body.metadata;
  const rawReasons =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).ineligibility_reasons
      : undefined;
  const ineligibilityReasons = Array.isArray(rawReasons)
    ? rawReasons
        .flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const reason = (item as Record<string, unknown>).reason;
          if (typeof reason !== "string") return [];
          const sanitized = sanitizeProviderReason(reason);
          return sanitized ? [sanitized] : [];
        })
        .slice(0, 10)
    : [];

  return { status, ineligibilityReasons };
}

/**
 * Decide ONE terminal class for a failed pi run, most-specific fact first.
 *
 * The order is the whole contract, because it is what keeps a stall from being
 * relabelled by whatever happened afterwards:
 *
 *  1. elek killed the child          -> the kill reason (stall | timeout | max_turns)
 *  2. a structured provider status   -> provider_transient | provider_permanent
 *  3. non-zero / signalled exit      -> process_error
 *  4. clean exit, nothing usable     -> invalid_output
 *  5. clean exit, output, error stop -> unknown  (never retried)
 *
 * Step 5 is deliberately `unknown` rather than a guess. An error stop reason with
 * no structured status is exactly the case where inferring from prose would be
 * tempting and wrong.
 */
export function classifyRunFailure(args: {
  terminationReason?: PiTerminationReason;
  providerFailureClass?: PiFailureClass;
  exitCode: number | null;
  hasOutput: boolean;
}): PiFailureClass {
  if (args.terminationReason) return args.terminationReason;
  if (args.providerFailureClass) return args.providerFailureClass;
  if (args.exitCode !== 0) return "process_error";
  if (!args.hasOutput) return "invalid_output";
  return "unknown";
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function killPiProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Process already exited.
  }
}

/**
 * Run pi with streaming JSON mode output.
 * Calls onProgress for each event so the caller can update the tracking comment.
 */
export async function runPi(
  prompt: string,
  inputs: ActionInputs,
  onProgress?: (event: ProgressEvent) => Promise<void>,
  /** When true, pi loads extensions (needed for pi-mcp-adapter). */
  loadExtensions?: boolean,
  options: { promptName?: string } = {},
): Promise<PiRunResult> {
  validateReasoningSchedule(inputs.reasoningMaxTokens, [inputs.thinking]);
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  const promptStem = (options.promptName || "prompt")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "prompt";
  const promptFile = join(promptDir, `${promptStem}.md`);
  writeFileSync(promptFile, prompt, "utf-8");

  // EHAC-2280 (AC #2): OpenRouter provider-routing preferences reach the wire through
  // pi's own config surface, not through a request builder — elek has no OpenRouter
  // HTTP client. pi documents `compat.openRouterRouting` as "sent as-is in the
  // `provider` field of the OpenRouter API request" (docs/models.md:458), and the T1
  // spike confirmed the value actually leaves the process rather than merely being
  // written to a file: the outgoing payload carried a matching `provider` object,
  // observed both at pi's hook and at the receiving server.
  //
  // Written beside the prompt, under RUNNER_TEMP. Nothing is written when the input is
  // unset, so an unconfigured caller keeps today's config resolution byte for byte.
  const routingAgentDir = writeRoutingConfig(tmpDir, inputs.model, inputs.openRouterProviderPreferences);

  const piBin = findPiBinary();
  const args = buildPiArgs(inputs, promptFile, !!loadExtensions);
  const env = buildPiEnv(inputs);
  if (routingAgentDir) {
    // Relocating the agent dir also relocates pi's `auth.json`. That is safe here and
    // was checked at source rather than assumed: the OpenRouter provider authenticates
    // via `envApiKeyAuth([... "OPENROUTER_API_KEY"])`, an environment-variable read, and
    // buildPiEnv already passes that key through. OAuth-based auth would be affected,
    // which is why this only happens when a caller opts in.
    if (process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR !== routingAgentDir) {
      console.warn(
        `::warning::openrouter_provider_preferences is set, so PI_CODING_AGENT_DIR is being ` +
          `redirected from "${process.env.PI_CODING_AGENT_DIR}" to "${routingAgentDir}" for this run. ` +
          "Any models.json in the original directory will NOT be applied.",
      );
    }
    env.PI_CODING_AGENT_DIR = routingAgentDir;
  }

  console.log(`pi binary: ${piBin}`);
  const cliThinking = piThinkingLevel(inputs.thinking);
  console.log(
    `Provider: ${inputs.provider}, Model: ${inputs.model || "default"}, Requested thinking: ${
      cliThinking === inputs.thinking ? inputs.thinking : `${inputs.thinking} (pi ${cliThinking})`
    }`,
  );
  const runModelLabel = modelLabelFor(inputs);

  let reasoning: ReasoningTelemetry | undefined;
  let reasoningObserved = false;
  const startTime = Date.now();
  let sessionId: string | undefined;
  let toolCount = 0;
  let turnCount = 0;
  let providerRetries = 0;
  let finalAssistant: PiAssistantMessage | undefined;
  let lastErrorMessage: string | undefined;
  let terminationMessage: string | undefined;
  let terminationReason: PiTerminationReason | undefined;
  /** Established from STRUCTURED provider state only — never from message text. */
  let providerFailureClass: PiFailureClass | undefined;
  let providerHttpStatus: number | undefined;
  let settled = false;
  // Stream-idle telemetry. Emitted on every terminal path so the watchdog
  // threshold can be calibrated from successful runs rather than guessed.
  let firstEventAt: number | undefined;
  let lastActivityAt = Date.now();
  let maxIdleSeconds = 0;
  let streamEventCount = 0;
  let malformedLineCount = 0;
  let lastEventType: string | undefined;
  // Streaming text deltas — used as a fallback if agent_end is missing.
  // Reset at every turn_start so we keep only the last turn's text.
  let streamingText = "";

  // pi --mode json hangs forever when spawned with stdio:["pipe",…] from
  // Node — pi keeps the stdin pipe open waiting for input that never
  // arrives. Reproduced locally (see /tmp/elek-debug/repro.mjs in dev
  // history): hang with stdio:["pipe",…], works perfectly with
  // stdio:["ignore",…] (stdin closed). The fix is in the spawn call below.
  // Set ELEK_PI_TEXT_MODE=1 to fall back to `pi -p` if JSON mode regresses.
  const useJsonMode = process.env.ELEK_PI_TEXT_MODE !== "1";

  return new Promise((resolve) => {
    const finalArgs = useJsonMode
      ? [...args.filter((a) => a !== "-p"), "--mode", "json"]
      : ["-p", ...args];

    console.log(
      `Command: ${piBin} ${finalArgs.map((a) => (a.startsWith("@") ? "@<prompt>" : a)).join(" ")}`,
    );

    const child = spawn(piBin, finalArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"], // close stdin (pi -p doesn't read it)
      detached: process.platform !== "win32",
    });
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    // The FIRST terminal condition wins. A later timer callback — or a close
    // that races a kill — can never rewrite the class, because every writer goes
    // through here and here is guarded. Without that guard the wall-clock timer
    // firing one tick after a stall kill would relabel a stall as a timeout, and
    // the retry policy would pick the wrong recovery.
    const terminatePi = (message: string, reason: PiTerminationReason) => {
      if (terminationMessage || settled) return;
      terminationMessage = message;
      terminationReason = reason;
      console.error(message);
      clearIdleTimer();
      killPiProcess(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled && child.exitCode === null) {
          killPiProcess(child.pid, "SIGKILL");
        }
      }, 1000);
    };

    const timeoutMs = inputs.runTimeoutSeconds * 1000;
    const timeoutTimer = setTimeout(
      () => terminatePi(`pi timed out after ${inputs.runTimeoutSeconds}s`, "timeout"),
      timeoutMs,
    );

    // ── Stream-idle watchdog (INDEPENDENT of the wall clock above) ────────────
    //
    // One wall-clock timer cannot distinguish a hung provider request from
    // genuinely slow work: both burn the full budget and both report `timeout`.
    // Measured on eha_care PR #3291 (job 95521213463), a 3,612-character prompt
    // produced 600s of complete silence, then a retry produced another 600s of
    // the same. The idle timer separates those two populations by asking a
    // different question — "when did we last hear anything?" — and terminates a
    // silent child near the threshold instead of at the cap.
    //
    // In ELEK_PI_TEXT_MODE the watchdog is DISABLED, not merely re-sourced.
    // `pi -p` returns one buffered answer at the end of the run, so a healthy
    // text-mode review legitimately emits nothing for its entire duration and a
    // gap-based timer would kill it. Text mode is the emergency fallback; a
    // watchdog that breaks the fallback is worse than no watchdog there.
    const stallTimeoutSeconds = Math.max(0, inputs.stallTimeoutSeconds ?? 0);
    const idleWatchdogEnabled = stallTimeoutSeconds > 0 && useJsonMode;
    if (stallTimeoutSeconds > 0 && !useJsonMode) {
      console.warn(
        "stall watchdog disabled: ELEK_PI_TEXT_MODE emits no incremental stream, " +
          "so a gap-based timer cannot tell a healthy buffered run from a hung one.",
      );
    }

    const armIdleTimer = () => {
      if (!idleWatchdogEnabled) return;
      // Clear-then-set, never set-alongside: two live idle timers would make the
      // effective threshold whichever one happened to be older.
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        maxIdleSeconds = Math.max(maxIdleSeconds, (Date.now() - lastActivityAt) / 1000);
        terminatePi(
          `pi stalled: no valid stream activity for ${stallTimeoutSeconds}s`,
          "stall",
        );
      }, stallTimeoutSeconds * 1000);
    };

    /** Record one unit of stream progress and restart the idle countdown. */
    const noteStreamActivity = (eventType?: string) => {
      const now = Date.now();
      maxIdleSeconds = Math.max(maxIdleSeconds, (now - lastActivityAt) / 1000);
      lastActivityAt = now;
      if (firstEventAt === undefined) firstEventAt = now;
      streamEventCount++;
      if (eventType) lastEventType = eventType;
      armIdleTimer();
    };

    /** Freeze telemetry at settlement, including the trailing silent gap. */
    const streamTelemetry = () => {
      maxIdleSeconds = Math.max(maxIdleSeconds, (Date.now() - lastActivityAt) / 1000);
      return {
        timeToFirstEventSeconds:
          firstEventAt === undefined ? null : roundSeconds((firstEventAt - startTime) / 1000),
        maxIdleSecondsObserved: roundSeconds(maxIdleSeconds),
        streamEventCount,
        ...(reasoning ? { reasoning } : {}),
        malformedLineCount,
        ...(lastEventType ? { lastEventType } : {}),
      };
    };

    lastActivityAt = Date.now();
    armIdleTimer();

    let stderr = "";
    let stdoutRaw = "";

    const stderrLines = createInterface({ input: child.stderr! });
    stderrLines.on("line", (line) => {
      if (!line.startsWith(REASONING_TELEMETRY_PREFIX)) {
        stderr += `${line}\n`;
        return;
      }
      if (line === REASONING_NOT_APPLICABLE) {
        reasoningObserved = true;
        reasoning = undefined;
        return;
      }
      const observed = parseReasoningTelemetry(line);
      if (!observed || observed.requestedThinking !== inputs.thinking.trim().toLowerCase()) return;
      reasoning = observed;
      reasoningObserved = true;
      console.log(`Reasoning: requested=${observed.requestedThinking} pi=${observed.piThinking} ` +
        `configuredMode=${observed.configuredMode} effectiveControl=${observed.effectiveControl} ` +
        `adapted=${observed.adapted}`);
    });

    if (!useJsonMode) {
      // Text mode: just collect stdout as the assistant's review text. Chunks
      // still count as activity so the telemetry is comparable across modes,
      // even though the idle watchdog is disabled here (see above).
      child.stdout!.on("data", (chunk) => {
        stdoutRaw += chunk.toString();
        noteStreamActivity("stdout_chunk");
      });
    }

    const rl = useJsonMode
      ? createInterface({ input: child.stdout! })
      : null;

    rl?.on("line", (line: string) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON line (warnings, banner text). COUNTED for diagnostics, but
        // deliberately NOT treated as activity: a process wedged in a loop that
        // prints garbage would otherwise hold the watchdog open forever, which
        // is the exact failure the watchdog exists to bound.
        malformedLineCount++;
        return;
      }

      // Every successfully parsed event resets the countdown — not a hand-picked
      // subset. Selecting event types would make the threshold depend on which
      // phase pi happens to be in, so a long tool execution or a long thinking
      // block would false-stall while a genuinely hung request in an unselected
      // phase would not be caught.
      noteStreamActivity(typeof event?.type === "string" ? event.type : undefined);

      // Structured provider status, if this event carries one. Recorded rather
      // than acted on: the terminal class is decided once, at settlement.
      const providerStatus = providerStatusFromEvent(event);
      if (providerStatus !== undefined && providerFailureClass === undefined) {
        providerHttpStatus = providerStatus;
        providerFailureClass = classifyProviderStatus(providerStatus);
      }

      switch (event.type) {
        case "session":
          sessionId = event.id;
          break;

        case "turn_start":
          turnCount++;
          streamingText = "";
          if (turnCount > inputs.maxTurns) {
            terminatePi(`pi exceeded max turns (${inputs.maxTurns})`, "max_turns");
          }
          break;

        case "auto_retry_start":
          providerRetries++;
          console.warn(
            `pi provider retry ${event.attempt || providerRetries}/${event.maxAttempts || "?"} after ${event.delayMs || 0}ms`,
          );
          break;

        case "tool_execution_start": {
          const toolName: string = event.toolName || "unknown";
          toolCount++;
          // Render bash commands as `bash(<cmd>)` for nicer progress lines.
          const detail =
            toolName === "bash" && event.args?.command
              ? `bash(${String(event.args.command).split("\n")[0].slice(0, 60)})`
              : toolName;
          onProgress?.({ type: "tool_start", detail });
          break;
        }

        case "tool_execution_end":
          onProgress?.({
            type: "tool_end",
            detail: event.toolName || "tool",
          });
          break;

        case "message_update": {
          const update = event.assistantMessageEvent;
          if (!update) break;
          if (update.type === "text_delta") {
            streamingText += update.delta || "";
            onProgress?.({ type: "text" });
          } else if (update.type === "thinking_delta") {
            onProgress?.({ type: "thinking" });
          }
          break;
        }

        case "message_end": {
          const msg = event.message;
          if (msg?.role === "assistant") {
            finalAssistant = msg;
            if (msg.errorMessage) lastErrorMessage = msg.errorMessage;
          }
          break;
        }

        case "agent_end": {
          // Authoritative final state — pick the last assistant message.
          const messages: PiAssistantMessage[] = (event.messages || []).filter(
            (m: any) => m?.role === "assistant",
          );
          if (messages.length > 0) {
            finalAssistant = messages[messages.length - 1];
            if (finalAssistant?.errorMessage) lastErrorMessage = finalAssistant.errorMessage;
          }
          break;
        }
      }
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearIdleTimer();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const telemetry = streamTelemetry();
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(
        `pi exited code=${code} in ${elapsed.toFixed(1)}s · turns=${turnCount} · tools=${toolCount} · provider retries=${providerRetries}`,
      );
      console.log(
        `pi stream: events=${telemetry.streamEventCount} · malformed_lines=${telemetry.malformedLineCount} · ` +
          `time_to_first_event=${telemetry.timeToFirstEventSeconds ?? "none"}s · max_idle=${telemetry.maxIdleSecondsObserved}s · ` +
          `last_event=${telemetry.lastEventType ?? "none"}`,
      );

      // AWAIT the final progress update — otherwise it races with run.ts's
      // post-pi `updateTrackingComment(reviewBody)` and the progress checklist
      // can land *after* the review, overwriting it.
      try {
        await onProgress?.({ type: "done" });
      } catch {
        // already logged inside onProgress
      }

      const output = useJsonMode
        ? (extractAssistantText(finalAssistant) || streamingText.trim())
        : stdoutRaw.trim();
      const usage = exactRunCostFromPi(finalAssistant, runModelLabel, inputs.costRates) ?? estimateRunCost({
        modelLabel: runModelLabel,
        prompt,
        output,
        costRates: inputs.costRates,
      });
      const stopReason = finalAssistant?.stopReason;
      const isErrorStop = stopReason === "error" || stopReason === "aborted";
      const messageProviderError = providerErrorFromMessage(lastErrorMessage);
      if (providerHttpStatus === undefined && messageProviderError) {
        providerHttpStatus = messageProviderError.status;
        providerFailureClass = classifyProviderStatus(messageProviderError.status);
      }

      // EHAC-2280 AC #1. Which OpenRouter endpoint actually served this run — the one
      // thing `modelLabel` cannot tell us, and the difference between "the review
      // timed out" and "the review was routed somewhere slow".
      //
      // Deliberately AWAITED before resolving, so the value lands on the same
      // PiRunResult as the run it describes rather than arriving after the coverage
      // record is written. Bounded by construction (see openrouter-generation.ts) and
      // incapable of throwing, so it can neither hang nor fail the review; the worst
      // case is ~10s of extra settlement against a 900s per-run budget.
      //
      // Also runs on the FAILURE path on purpose: a lens that failed is exactly the
      // one whose serving endpoint is worth knowing.
      const generationFields = await captureGeneration(finalAssistant);

      const missingReasoning = needsReasoningExtension(inputs) && !reasoningObserved;
      const otherwiseSuccessful = !terminationMessage && code === 0 && Boolean(output) && !isErrorStop;
      if (!terminationMessage && code === 0 && output && !isErrorStop && !missingReasoning) {
        resolve({
          conclusion: "success",
          output,
          sessionId,
          turnsUsed: turnCount,
          providerRetries,
          durationSeconds: elapsed,
          costUsd: usage.costUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimated: usage.estimated,
            modelLabel: usage.modelLabel,
            source: usage.source,
          },
          ...generationFields,
          ...telemetry,
        });
      } else {
        const errMsg =
          terminationMessage ||
          (missingReasoning && otherwiseSuccessful ? "Reasoning request telemetry missing from configured Pi extension" : "") ||
          lastErrorMessage ||
          output ||
          stderr.trim().slice(-500) ||
          `pi exited with code ${code}`;
        const failureClass = missingReasoning && otherwiseSuccessful ? "process_error" : classifyRunFailure({
          terminationReason,
          providerFailureClass,
          exitCode: code,
          hasOutput: Boolean(output),
        });
        console.error(`pi failed: ${errMsg.substring(0, 500)}`);
        console.error(`pi failure_class=${failureClass}`);
        resolve({
          conclusion: "failure",
          output: errMsg,
          sessionId,
          turnsUsed: turnCount,
          providerRetries,
          durationSeconds: elapsed,
          costUsd: usage.costUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimated: usage.estimated,
            modelLabel: usage.modelLabel,
            source: usage.source,
          },
          failureClass,
          ...(terminationReason ? { terminationReason } : {}),
          ...(providerHttpStatus !== undefined ? { providerHttpStatus } : {}),
          ...(messageProviderError && messageProviderError.status === providerHttpStatus &&
          messageProviderError.ineligibilityReasons.length > 0
            ? { providerIneligibilityReasons: messageProviderError.ineligibilityReasons }
            : {}),
          ...generationFields,
          ...telemetry,
        });
      }
    });

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearIdleTimer();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const telemetry = streamTelemetry();
      const elapsed = (Date.now() - startTime) / 1000;
      console.error(`pi spawn error:`, err.message);
      try {
        await onProgress?.({ type: "done" });
      } catch {
        // already logged inside onProgress
      }
      resolve({
        conclusion: "failure",
        output: err.message,
        turnsUsed: 0,
        providerRetries,
        durationSeconds: elapsed,
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          estimated: false,
          modelLabel: runModelLabel,
          source: "unknown",
        },
        failureClass: "process_error",
        ...telemetry,
      });
    });
  });
}

/**
 * Resolve the OpenRouter serving-endpoint fields for one settled run (EHAC-2280).
 *
 * Returns `{}` — genuinely ABSENT fields, not nulls — for any run the lookup does not
 * apply to. That distinction is the whole contract: a non-OpenRouter review's
 * coverage record stays byte-identical to what it was before this existed, while an
 * OpenRouter run that could not be resolved records an honest `null` meaning "not
 * reported". Writing nulls for both would make the two indistinguishable.
 */
async function captureGeneration(
  msg: PiAssistantMessage | undefined,
): Promise<Partial<PiRunResult>> {
  const subject = { responseId: msg?.responseId, provider: msg?.provider };
  // elek's own process holds the key (buildPiEnv passes the SAME value through to pi),
  // so no new credential plumbing is introduced by this lookup.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!isGenerationLookupApplicable(subject, apiKey)) return {};

  const record = await lookupGenerationRecord(subject, { apiKey });
  if (record.servingProvider) {
    console.log(
      `pi served by: ${record.servingProvider} · reasoning_tokens=${
        record.nativeTokensReasoning ?? "n/a"
      } · generation_time=${record.generationTimeMs ?? "?"}ms · latency=${record.latencyMs ?? "?"}ms`,
    );
  }
  return { ...record, responseId: subject.responseId };
}

/** Concatenate the text content blocks of an assistant message. */
function extractAssistantText(msg?: PiAssistantMessage): string {
  if (!msg) return "";
  return msg.content
    .filter((c): c is PiTextContent => c.type === "text" && typeof (c as PiTextContent).text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

function exactRunCostFromPi(
  msg: PiAssistantMessage | undefined,
  modelLabel: string,
  costRates: string,
): ReviewCost | undefined {
  const usage = msg?.usage;
  if (!usage) return undefined;
  const inputTokens = firstNonNegativeInteger(
    usage.input,
    usage.inputTokens,
    usage.promptTokens,
  );
  const outputTokens = firstNonNegativeInteger(
    usage.output,
    usage.outputTokens,
    usage.completionTokens,
  );
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const safeInput = inputTokens ?? 0;
  const safeOutput = outputTokens ?? 0;
  if (safeInput === 0 && safeOutput === 0) return undefined;

  const providerCost = nonNegativeNumber(usage.cost?.total);
  if (providerCost !== undefined) {
    return {
      inputTokens: safeInput,
      outputTokens: safeOutput,
      costUsd: providerCost,
      estimated: false,
      modelLabel,
      source: "provider",
    };
  }

  const rates = resolveRates(modelLabel, costRates);
  const costUsd =
    (safeInput / 1_000_000) * rates.inputPerMillion +
    (safeOutput / 1_000_000) * rates.outputPerMillion;
  return {
    inputTokens: safeInput,
    outputTokens: safeOutput,
    costUsd,
    estimated: true,
    modelLabel,
    source: rates.source,
  };
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    return Math.floor(value);
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Build the CLI arguments for pi.
 */
export function buildPiArgs(
  inputs: ActionInputs,
  promptFile: string,
  loadExtensions: boolean,
): string[] {
  const args: string[] = [
    "--no-session",
    "--thinking", piThinkingLevel(inputs.thinking),
    "--no-skills",
    "--no-context-files",
  ];
  // `pi --model provider/model` is legal, but pairing that with a separate
  // `--provider` can make multi-provider review strategies ambiguous. When
  // the model is provider-qualified, let the model spec route itself.
  if (!inputs.model?.includes("/")) {
    args.push("--provider", inputs.provider);
  }
  // Do not rely on user/global extension discovery or a runtime `pi install`
  // (which would hit the npm registry during a review). Load exactly the
  // already-installed, lockfile-pinned local adapter package when MCP is needed.
  args.push("--no-extensions");
  if (usesReadonlyReviewTools(inputs)) {
    args.push("--no-builtin-tools", "-e", localPiReadonlyToolsPath());
  }
  if (loadExtensions) {
    args.push("-e", localPiMcpAdapterPath());
  }
  // A configured map observes each attempt, including unchanged effort-mode payloads.
  // This makes telemetry reflect Pi's resolved model and thinking-level mapping.
  if (needsReasoningExtension(inputs)) {
    args.push("-e", localPiReasoningCapPath());
  }

  // Empty model string intentionally means "use this provider's default".
  if (inputs.model) {
    args.push("--model", inputs.model);
  }

  if (inputs.systemPrompt) {
    args.push("--system-prompt", inputs.systemPrompt);
  }
  if (inputs.mode !== "agent") {
    args.push("--append-system-prompt", REVIEW_SYSTEM_PROMPT);
  }

  if (inputs.tools) {
    args.push("--tools", inputs.tools);
  }

  args.push(`@${promptFile}`);

  return args;
}

function localPiMcpAdapterPath(): string {
  const packageRoot = process.env.GITHUB_ACTION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(packageRoot, "node_modules", "pi-mcp-adapter");
}

function localPiReasoningCapPath(): string {
  const packageRoot = process.env.GITHUB_ACTION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(packageRoot, "src", "pi-openrouter-observe.ts");
}

function localPiReadonlyToolsPath(): string {
  const packageRoot = process.env.GITHUB_ACTION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(packageRoot, "src", "pi-readonly-tools.ts");
}

function toolSet(inputs: ActionInputs): Set<string> {
  return new Set(
    (inputs.tools || "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
}

function usesReadonlyReviewTools(inputs: ActionInputs): boolean {
  if (inputs.mode === "agent") return false;
  const tools = toolSet(inputs);
  const hasReadonlyTool = ["read", "grep", "find", "ls"].some((tool) => tools.has(tool));
  const hasMutationTool = ["write", "edit", "bash"].some((tool) => tools.has(tool));
  return hasReadonlyTool && !hasMutationTool;
}

function needsReasoningExtension(inputs: ActionInputs): boolean {
  return inputs.reasoningMaxTokens !== undefined || Object.keys(inputs.openRouterReasoningModes ?? {}).length > 0;
}

/**
 * Build the environment variables for pi.
 *
 * Both review and agent modes use a strict allowlist instead of leaking
 * `{ ...process.env }`. Agent mode runs a child that may execute shell (git
 * commit/push), so blindly passing the parent env would expose every secret
 * the workflow ever set to a process that can run arbitrary commands. Agent
 * mode only gets a few extra GitHub/workflow vars beyond the review baseline
 * — enough for git auth + pushing — never the whole environment.
 */
function buildPiEnv(inputs: ActionInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (needsReasoningExtension(inputs)) {
    env[REASONING_MODES_ENV] = JSON.stringify(inputs.openRouterReasoningModes ?? {});
    env[REASONING_THINKING_ENV] = inputs.thinking.trim().toLowerCase();
    if (inputs.reasoningMaxTokens !== undefined) env[REASONING_MAX_TOKENS_ENV] = String(inputs.reasoningMaxTokens);
  }

  // Baseline allowed in every mode: locale, temp dirs, and pi's own paths.
  const baseAllowedVars = [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "RUNNER_TEMP",
    "GITHUB_ACTION_PATH", "GITHUB_WORKSPACE", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
  ];

  // Agent mode runs shell and pushes commits, so it additionally needs the
  // standard GitHub Actions context vars and the token git auth relies on.
  // This is deliberately narrow — NOT the full parent environment.
  const agentExtraVars = [
    "GITHUB_TOKEN", "GH_TOKEN",
    "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_OWNER",
    "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_GRAPHQL_URL",
    "GITHUB_RUN_ID", "GITHUB_RUN_NUMBER", "GITHUB_SHA", "GITHUB_REF",
    "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GITHUB_BASE_REF",
    "GITHUB_WORKSPACE", "GITHUB_EVENT_NAME", "GITHUB_ACTOR",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  ];

  const allowedVars = inputs.mode === "agent"
    ? [...baseAllowedVars, ...agentExtraVars]
    : baseAllowedVars;

  for (const v of allowedVars) {
    if (process.env[v] !== undefined) env[v] = process.env[v];
  }

  if (inputs.mode !== "agent" && toolSet(inputs).has("mcp") && process.env.GITHUB_TOKEN !== undefined) {
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  Object.assign(env, {
    HOME: process.env.HOME || "/root",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });

  // Pass through all API key env vars that pi's AuthStorage checks
  const keyVars = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "TOGETHER_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
    "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];

  for (const v of keyVars) {
    if (process.env[v]) env[v] = process.env[v];
  }

  return env;
}

/**
 * Test seam: the env builder is internal, but tests need to assert the
 * agent-mode allowlist doesn't leak arbitrary parent secrets.
 */
export const __buildPiEnv = buildPiEnv;
