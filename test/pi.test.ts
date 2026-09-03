import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __buildPiEnv,
  buildPiArgs,
  classifyProviderStatus,
  classifyRunFailure,
  providerErrorFromMessage,
  providerStatusFromEvent,
  runPi,
} from "../src/pi";
import type { ActionInputs } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  systemPrompt: "",
  maxTurns: 20,
  runTimeoutSeconds: 600,
  stallTimeoutSeconds: 0,
  tools: "read,grep,find,ls",
  configPath: ".elek.yml",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  reviewAgentCount: undefined,
  validatorModel: "",
  validatorThinking: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
};

const originalPiExecutable = process.env.PI_EXECUTABLE;

afterEach(() => {
  if (originalPiExecutable === undefined) {
    delete process.env.PI_EXECUTABLE;
  } else {
    process.env.PI_EXECUTABLE = originalPiExecutable;
  }
});

describe("buildPiArgs", () => {
  it("omits --model when the provider default model is requested", () => {
    const args = buildPiArgs({ ...baseInputs, model: "" }, "/tmp/prompt.md", false);

    expect(args).toContain("--provider");
    expect(args).toContain("deepseek");
    expect(args).not.toContain("--model");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-builtin-tools");
    expect(args.join(" ")).toContain("src/pi-readonly-tools.ts");
  });

  it("defensively omits --model when model is undefined", () => {
    const args = buildPiArgs(
      { ...baseInputs, model: undefined as unknown as string },
      "/tmp/prompt.md",
      false,
    );

    expect(args).toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("lets provider-qualified model specs route themselves", () => {
    const args = buildPiArgs(
      {
        ...baseInputs,
        provider: "openrouter",
        model: "openrouter/moonshotai/kimi-k2.7-code",
      },
      "/tmp/prompt.md",
      true,
    );

    expect(args).not.toContain("--provider");
    expect(args).toContain("--model");
    expect(args).toContain("openrouter/moonshotai/kimi-k2.7-code");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("-e");
    expect(args).toContain("--no-builtin-tools");
    expect(args.join(" ")).toContain("src/pi-readonly-tools.ts");
    expect(args.join(" ")).toContain("node_modules/pi-mcp-adapter");
  });

  it("maps user-facing max thinking to pi's highest supported CLI level", () => {
    const args = buildPiArgs({ ...baseInputs, thinking: "max" }, "/tmp/prompt.md", false);

    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("xhigh");
  });

  it("appends Elek's noninteractive reviewer contract in review mode", () => {
    const args = buildPiArgs(baseInputs, "/tmp/prompt.md", false);
    const promptIndex = args.indexOf("--append-system-prompt");

    expect(promptIndex).toBeGreaterThan(-1);
    expect(args[promptIndex + 1]).toContain("noninteractive read-only CI");
    expect(args[promptIndex + 1]).toContain(
      "Use repository inspection tools only to resolve a specific uncertainty",
    );
  });

  it("does not impose the reviewer contract on legacy agent mode", () => {
    const args = buildPiArgs(
      { ...baseInputs, mode: "agent" },
      "/tmp/prompt.md",
      false,
    );

    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("buildPiEnv", () => {
  const secretVars = ["SECRET_SHOULD_NOT_LEAK", "MY_DEPLOY_KEY", "AWS_BILLING_TOKEN"];

  afterEach(() => {
    for (const v of secretVars) delete process.env[v];
    delete process.env.GITHUB_TOKEN;
    delete process.env.TOGETHER_API_KEY;
  });

  it("does not leak arbitrary parent secrets into agent-mode child env", () => {
    for (const v of secretVars) process.env[v] = "leaked-value";
    process.env.GITHUB_TOKEN = "ghs_fake_token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";

    const env = __buildPiEnv({ ...baseInputs, provider: "anthropic", mode: "agent" });

    for (const v of secretVars) {
      expect(env[v]).toBeUndefined();
    }
    // But the vars agent mode legitimately needs are still present.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBeDefined();
    expect(env.GITHUB_TOKEN).toBe("ghs_fake_token");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fake");
    expect(env.PI_OFFLINE).toBe("1");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("review mode does not leak secrets and omits GITHUB_TOKEN", () => {
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";
    process.env.GITHUB_TOKEN = "ghs_fake_token";

    const env = __buildPiEnv({ ...baseInputs, mode: "review" });

    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    // GITHUB_TOKEN is granted to review mode only when the MCP proxy is enabled.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("review mode passes GITHUB_TOKEN only when MCP is enabled", () => {
    process.env.GITHUB_TOKEN = "ghs_fake_token";

    const env = __buildPiEnv({ ...baseInputs, mode: "review", tools: "read,grep,find,ls,mcp" });

    expect(env.GITHUB_TOKEN).toBe("ghs_fake_token");
  });

  it("passes Together credentials to the review child env without leaking unrelated secrets", () => {
    process.env.TOGETHER_API_KEY = "together-fake-key";
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";

    const env = __buildPiEnv({ ...baseInputs, provider: "together", mode: "review" });

    expect(env.TOGETHER_API_KEY).toBe("together-fake-key");
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
  });
});

describe("runPi", () => {
  it("uses provider-reported JSON usage when pi emits exact token and cost data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-usage-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      "{\"type\":\"session\",\"id\":\"session-1\"}",
      "{\"type\":\"turn_start\"}",
      "{\"type\":\"auto_retry_start\",\"attempt\":1,\"maxAttempts\":3,\"delayMs\":1000,\"errorMessage\":\"rate limited\"}",
      "{\"type\":\"auto_retry_end\",\"success\":true,\"attempt\":1}",
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":1234,\"output\":56,\"cost\":{\"total\":0.00789}},\"stopReason\":\"stop\"}}",
      "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":1234,\"output\":56,\"cost\":{\"total\":0.00789}},\"stopReason\":\"stop\"}]}",
      "JSON",
      "",
    ].join("\n"), "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const result = await runPi(
        "review this change",
        { ...baseInputs, provider: "together", model: "together/moonshotai/Kimi-K2.7-Code" },
        undefined,
        false,
        { promptName: "usage-test" },
      );

      expect(result.conclusion).toBe("success");
      expect(result.output).toBe("done");
      expect(result.usage).toMatchObject({
        inputTokens: 1234,
        outputTokens: 56,
        estimated: false,
        modelLabel: "together/moonshotai/Kimi-K2.7-Code",
        source: "provider",
      });
      expect(result.providerRetries).toBe(1);
      expect(result.costUsd).toBe(0.00789);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a failure result when pi exceeds the configured timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-timeout-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, "#!/usr/bin/env bash\nsleep 10\n", "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const progressEvents: string[] = [];
      const result = await runPi(
        "review this change",
        { ...baseInputs, runTimeoutSeconds: 1 },
        async (event) => {
          progressEvents.push(event.type);
        },
        false,
        { promptName: "timeout-test" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.output).toBe("pi timed out after 1s");
      expect(result.durationSeconds).toBeGreaterThanOrEqual(1);
      expect(progressEvents).toContain("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminates a run when pi starts more than maxTurns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-turn-limit-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', () => process.exit(0));",
      "console.log(JSON.stringify({ type: 'session', id: 'session-turn-limit' }));",
      "console.log(JSON.stringify({ type: 'turn_start' }));",
      "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'premature output' }], stopReason: 'stop' } }));",
      "console.log(JSON.stringify({ type: 'turn_start' }));",
      "console.log(JSON.stringify({ type: 'turn_start' }));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"), "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const result = await runPi(
        "review this change",
        { ...baseInputs, maxTurns: 2, runTimeoutSeconds: 10 },
        undefined,
        false,
        { promptName: "turn-limit-test" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.output).toBe("pi exceeded max turns (2)");
      expect(result.turnsUsed).toBe(3);
      expect(result.durationSeconds).toBeLessThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Stream-idle watchdog + failure taxonomy (EHAC-2231, D1).
 *
 * A one-second threshold keeps these honest AND fast: every case below asserts
 * that termination happens NEAR the threshold, which is the property that
 * separates a working watchdog from a wall-clock timer with a new name.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Write an executable fake pi and point PI_EXECUTABLE at it. */
function fakePi(prefix: string, lines: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `elek-${prefix}-`));
  const bin = join(dir, "pi");
  writeFileSync(bin, lines.join("\n") + "\n", "utf-8");
  chmodSync(bin, 0o755);
  process.env.PI_EXECUTABLE = bin;
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const okAssistant =
  "{ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'review body' }], stopReason: 'stop' }] }";

describe("classifyProviderStatus", () => {
  it("maps rate limits and server errors to a retryable transient class", () => {
    expect(classifyProviderStatus(429)).toBe("provider_transient");
    expect(classifyProviderStatus(503)).toBe("provider_transient");
    expect(classifyProviderStatus(529)).toBe("provider_transient");
    expect(classifyProviderStatus(599)).toBe("provider_transient");
  });

  it("maps auth and configuration statuses to a permanent class", () => {
    expect(classifyProviderStatus(401)).toBe("provider_permanent");
    expect(classifyProviderStatus(403)).toBe("provider_permanent");
    expect(classifyProviderStatus(404)).toBe("provider_permanent");
  });

  it("refuses to classify anything that is not a structured integer status", () => {
    expect(classifyProviderStatus("429")).toBeUndefined();
    expect(classifyProviderStatus("rate_limit_exceeded")).toBeUndefined();
    expect(classifyProviderStatus(undefined)).toBeUndefined();
    expect(classifyProviderStatus(200)).toBeUndefined();
    expect(classifyProviderStatus(4.29)).toBeUndefined();
  });
});

describe("providerStatusFromEvent", () => {
  it("reads a status from each supported structured container", () => {
    expect(providerStatusFromEvent({ type: "error", status: 429 })).toBe(429);
    expect(providerStatusFromEvent({ type: "x", error: { statusCode: 503 } })).toBe(503);
    expect(
      providerStatusFromEvent({ type: "message_update", assistantMessageEvent: { error: { status: 401 } } }),
    ).toBe(401);
    expect(providerStatusFromEvent({ type: "message_end", message: { error: { http_status: 500 } } })).toBe(500);
  });

  it("returns nothing for prose-only errors — the class must not be guessed from text", () => {
    expect(
      providerStatusFromEvent({ type: "message_end", message: { errorMessage: "429 Too Many Requests" } }),
    ).toBeUndefined();
    expect(providerStatusFromEvent({ type: "error", code: "rate_limit_exceeded" })).toBeUndefined();
  });
});

describe("providerErrorFromMessage", () => {
  it("parses the exact structured provider envelope emitted by pi", () => {
    const error = providerErrorFromMessage(
      '404: {"message":"0 endpoints available","code":404,"metadata":{"ineligibility_reasons":[{"reason":"model-ignored-by-guardrail"}]}}',
    );

    expect(error).toEqual({
      status: 404,
      ineligibilityReasons: ["model-ignored-by-guardrail"],
    });
  });

  it("rejects prose, malformed JSON, string codes, and status mismatches", () => {
    expect(providerErrorFromMessage('request failed with 404: {"code":404}')).toBeUndefined();
    expect(providerErrorFromMessage('404: {"code":')).toBeUndefined();
    expect(providerErrorFromMessage('404: {"code":"404"}')).toBeUndefined();
    expect(providerErrorFromMessage('404: {"code":403}')).toBeUndefined();
  });

  it("bounds and sanitizes provider-owned reason values", () => {
    const reasons = Array.from({ length: 12 }, (_, index) => ({
      reason: `${index}\u0000${"x".repeat(140)}`,
    }));
    const error = providerErrorFromMessage(`404: ${JSON.stringify({ code: 404, metadata: { ineligibility_reasons: reasons } })}`);

    expect(error?.ineligibilityReasons).toHaveLength(10);
    expect(error?.ineligibilityReasons[0]).not.toContain("\u0000");
    expect(error?.ineligibilityReasons[0]?.length).toBe(128);
  });
});

describe("classifyRunFailure", () => {
  it("prefers the kill reason over everything else, so a stall stays a stall", () => {
    expect(
      classifyRunFailure({
        terminationReason: "stall",
        providerFailureClass: "provider_transient",
        exitCode: null,
        hasOutput: true,
      }),
    ).toBe("stall");
  });

  it("falls through the documented order when elek did not kill the child", () => {
    expect(
      classifyRunFailure({ providerFailureClass: "provider_permanent", exitCode: 1, hasOutput: false }),
    ).toBe("provider_permanent");
    expect(classifyRunFailure({ exitCode: 1, hasOutput: true })).toBe("process_error");
    expect(classifyRunFailure({ exitCode: 0, hasOutput: false })).toBe("invalid_output");
    expect(classifyRunFailure({ exitCode: 0, hasOutput: true })).toBe("unknown");
  });
});

describe("runPi stream-idle watchdog", () => {
  it("never fires while valid events keep arriving inside the threshold", async () => {
    const { cleanup } = fakePi("stall-reset", [
      "#!/usr/bin/env node",
      "const emit = (o) => console.log(JSON.stringify(o));",
      "emit({ type: 'session', id: 's' });",
      "setTimeout(() => emit({ type: 'turn_start' }), 1200);",
      "setTimeout(() => emit({ type: 'tool_execution_start', toolName: 'read' }), 2400);",
      `setTimeout(() => { emit(${okAssistant}); process.exit(0); }, 3200);`,
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 30, stallTimeoutSeconds: 3 },
        undefined,
        false,
        { promptName: "stall-reset" },
      );

      expect(result.conclusion).toBe("success");
      expect(result.failureClass).toBeUndefined();
      expect(result.terminationReason).toBeUndefined();
      // The run outlived the threshold; no single GAP did. That distinction is
      // the entire point of an idle timer over a wall-clock timer.
      expect(result.durationSeconds).toBeGreaterThan(2);
      expect(result.maxIdleSecondsObserved!).toBeGreaterThan(1);
      expect(result.maxIdleSecondsObserved!).toBeLessThan(3);
      expect(result.streamEventCount!).toBeGreaterThanOrEqual(4);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("terminates near the threshold with failureClass=stall when events stop mid-run", async () => {
    const { cleanup } = fakePi("stall-mid", [
      "#!/usr/bin/env node",
      "const emit = (o) => console.log(JSON.stringify(o));",
      "emit({ type: 'session', id: 's' });",
      "emit({ type: 'turn_start' });",
      "setInterval(() => {}, 1000);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 60, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-mid" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.failureClass).toBe("stall");
      expect(result.terminationReason).toBe("stall");
      expect(result.output).toBe("pi stalled: no valid stream activity for 1s");
      // NEAR the threshold, not at the 60s wall clock. If this ever climbs to
      // ~60 the watchdog has stopped working and only the message survives.
      expect(result.durationSeconds).toBeLessThan(5);
      expect(result.timeToFirstEventSeconds).not.toBeNull();
      expect(result.lastEventType).toBe("turn_start");
    } finally {
      cleanup();
    }
  }, 20_000);

  it("reports a time-to-first-event stall when nothing is ever emitted", async () => {
    const { cleanup } = fakePi("stall-first", [
      "#!/usr/bin/env node",
      "setInterval(() => {}, 1000);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 60, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-first" },
      );

      expect(result.failureClass).toBe("stall");
      expect(result.timeToFirstEventSeconds).toBeNull();
      expect(result.streamEventCount).toBe(0);
      expect(result.durationSeconds).toBeLessThan(5);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("counts malformed lines without letting them hold a broken JSON-mode run open", async () => {
    const { cleanup } = fakePi("stall-garbage", [
      "#!/usr/bin/env node",
      "setInterval(() => console.log('not json at all'), 100);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 60, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-garbage" },
      );

      expect(result.failureClass).toBe("stall");
      // The property is not "how many lines" — it is that garbage arriving
      // CONTINUOUSLY did not hold the run open. The stall still fired near the
      // 1s threshold while stdout was never quiet.
      expect(result.malformedLineCount!).toBeGreaterThanOrEqual(1);
      expect(result.streamEventCount).toBe(0);
      expect(result.durationSeconds).toBeLessThan(5);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("does not false-stall a healthy text-mode fallback that emits no JSON", async () => {
    const previous = process.env.ELEK_PI_TEXT_MODE;
    process.env.ELEK_PI_TEXT_MODE = "1";
    const { cleanup } = fakePi("stall-text", [
      "#!/usr/bin/env node",
      "setTimeout(() => { process.stdout.write('buffered review body\\n'); process.exit(0); }, 2600);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 30, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-text" },
      );

      expect(result.conclusion).toBe("success");
      expect(result.output).toBe("buffered review body");
      expect(result.failureClass).toBeUndefined();
    } finally {
      cleanup();
      if (previous === undefined) delete process.env.ELEK_PI_TEXT_MODE;
      else process.env.ELEK_PI_TEXT_MODE = previous;
    }
  }, 20_000);

  it("lets the wall clock win when the stream is active but the run is simply too long", async () => {
    const { cleanup } = fakePi("stall-vs-timeout", [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', () => process.exit(0));",
      "const emit = (o) => console.log(JSON.stringify(o));",
      "emit({ type: 'session', id: 's' });",
      "setInterval(() => emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '.' } }), 200);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 2, stallTimeoutSeconds: 5 },
        undefined,
        false,
        { promptName: "stall-vs-timeout" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.failureClass).toBe("timeout");
      expect(result.terminationReason).toBe("timeout");
      expect(result.streamEventCount!).toBeGreaterThan(5);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("keeps max_turns distinguishable from stall and timeout", async () => {
    const { cleanup } = fakePi("stall-vs-turns", [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', () => process.exit(0));",
      "const emit = (o) => console.log(JSON.stringify(o));",
      "emit({ type: 'turn_start' });",
      "emit({ type: 'turn_start' });",
      "emit({ type: 'turn_start' });",
      "setInterval(() => {}, 1000);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, maxTurns: 2, runTimeoutSeconds: 30, stallTimeoutSeconds: 5 },
        undefined,
        false,
        { promptName: "stall-vs-turns" },
      );

      expect(result.failureClass).toBe("max_turns");
      expect(result.terminationReason).toBe("max_turns");
    } finally {
      cleanup();
    }
  }, 20_000);

  it("preserves the first failure class through SIGTERM -> SIGKILL escalation", async () => {
    const { cleanup } = fakePi("stall-sigkill", [
      "#!/usr/bin/env node",
      // Deliberately ignores SIGTERM: settlement must come from the SIGKILL path,
      // and the class recorded at kill time must survive it.
      "process.on('SIGTERM', () => {});",
      "console.log(JSON.stringify({ type: 'session', id: 's' }));",
      "setInterval(() => {}, 1000);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 60, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-sigkill" },
      );

      expect(result.failureClass).toBe("stall");
      expect(result.terminationReason).toBe("stall");
      expect(result.durationSeconds).toBeLessThan(8);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("settles exactly once when the child exits as the wall-clock timer fires", async () => {
    const { cleanup } = fakePi("stall-race", [
      "#!/usr/bin/env node",
      "const emit = (o) => console.log(JSON.stringify(o));",
      `setTimeout(() => { emit(${okAssistant}); process.exit(0); }, 1000);`,
    ]);
    try {
      const doneEvents: string[] = [];
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 1, stallTimeoutSeconds: 1 },
        async (event) => {
          if (event.type === "done") doneEvents.push(event.type);
        },
        false,
        { promptName: "stall-race" },
      );

      expect(doneEvents.length).toBe(1);
      // Whichever side won, exactly ONE class is reported and it is a legal one.
      if (result.conclusion === "failure") {
        expect(["stall", "timeout"]).toContain(result.failureClass);
      } else {
        expect(result.failureClass).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  }, 20_000);

  it("clears every timer on settlement, so nothing can rewrite the result afterwards", async () => {
    const { cleanup } = fakePi("stall-cleanup", [
      "#!/usr/bin/env node",
      "const emit = (o) => console.log(JSON.stringify(o));",
      `emit(${okAssistant});`,
      "process.exit(0);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 2, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-cleanup" },
      );

      expect(result.conclusion).toBe("success");
      const snapshot = JSON.stringify(result);
      // Outlive BOTH timers. A live idle or wall-clock timer would fire in here.
      await new Promise((r) => setTimeout(r, 2600));
      expect(JSON.stringify(result)).toBe(snapshot);
      expect(result.conclusion).toBe("success");
    } finally {
      cleanup();
    }
  }, 20_000);

  it("classifies a child that cannot be spawned as process_error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-stall-spawn-"));
    const bin = join(dir, "pi");
    writeFileSync(bin, "not executable", "utf-8");
    chmodSync(bin, 0o644);
    process.env.PI_EXECUTABLE = bin;
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 5, stallTimeoutSeconds: 1 },
        undefined,
        false,
        { promptName: "stall-spawn" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.failureClass).toBe("process_error");
      expect(result.terminationReason).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("classifies a clean exit with no usable output as invalid_output", async () => {
    const { cleanup } = fakePi("stall-empty", [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ type: 'session', id: 's' }));",
      "process.exit(0);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 10, stallTimeoutSeconds: 5 },
        undefined,
        false,
        { promptName: "stall-empty" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.failureClass).toBe("invalid_output");
    } finally {
      cleanup();
    }
  }, 20_000);

  it("classifies a structured provider status observed on the stream", async () => {
    const { cleanup } = fakePi("stall-provider", [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ type: 'session', id: 's' }));",
      "console.log(JSON.stringify({ type: 'error', status: 429, message: 'slow down' }));",
      "process.exit(1);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 10, stallTimeoutSeconds: 5 },
        undefined,
        false,
        { promptName: "stall-provider" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.failureClass).toBe("provider_transient");
    } finally {
      cleanup();
    }
  }, 20_000);

  it("classifies pi's structured errorMessage envelope without guessing from prose", async () => {
    const { cleanup } = fakePi("provider-envelope", [
      "#!/usr/bin/env node",
      "const body = { message: 'blocked', code: 404, metadata: { ineligibility_reasons: [{ reason: 'model-ignored-by-guardrail' }] } };",
      "console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: `404: ${JSON.stringify(body)}` }] }));",
      "process.exit(0);",
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 10, stallTimeoutSeconds: 5 },
        undefined,
        false,
        { promptName: "provider-envelope" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.failureClass).toBe("provider_permanent");
      expect(result.providerHttpStatus).toBe(404);
      expect(result.providerIneligibilityReasons).toEqual(["model-ignored-by-guardrail"]);
    } finally {
      cleanup();
    }
  }, 20_000);

  it("disables the watchdog entirely when stall_timeout_seconds is 0", async () => {
    const { cleanup } = fakePi("stall-off", [
      "#!/usr/bin/env node",
      "const emit = (o) => console.log(JSON.stringify(o));",
      "emit({ type: 'session', id: 's' });",
      `setTimeout(() => { emit(${okAssistant}); process.exit(0); }, 2500);`,
    ]);
    try {
      const result = await runPi(
        "review",
        { ...baseInputs, runTimeoutSeconds: 30, stallTimeoutSeconds: 0 },
        undefined,
        false,
        { promptName: "stall-off" },
      );

      expect(result.conclusion).toBe("success");
      // Telemetry is still emitted while the watchdog is off — that is what the
      // canary uses to CHOOSE a threshold before enabling it anywhere.
      expect(result.maxIdleSecondsObserved!).toBeGreaterThan(2);
    } finally {
      cleanup();
    }
  }, 20_000);
});
