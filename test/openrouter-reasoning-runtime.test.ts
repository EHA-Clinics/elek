import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPi, buildPiArgs } from "../src/pi";
import { parseInputs } from "../src/github/context";
import { executeLensWithRetry } from "../src/review/lens-execution";
import { metricFromPiRun } from "../src/review/summary";
import type { ModelSpec, ReviewJob } from "../src/review/strategy";

const MIMO = "xiaomi/mimo-v2.5-pro";
const PRO = "deepseek/deepseek-v4-pro";
const ROUTING = { require_parameters: true, data_collection: "deny", ignore: ["digitalocean"], allow_fallbacks: true };

describe("pinned Pi reasoning extension under Node", () => {
  it("observes real requests, isolates concurrent modes, records failure and resolves failover", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "elek-reasoning-runtime-"));
    const saved = new Map<string, string | undefined>();
    const set = (key: string, value: string) => { if (!saved.has(key)) saved.set(key, process.env[key]); process.env[key] = value; };
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const text = JSON.stringify(body.messages);
      if (text.includes("fail-permanent")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic provider failure", code: 404 } }));
        return;
      }
      const empty = text.includes("test-failover") && body.model === MIMO;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: empty ? "" : "No findings." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address missing");
      const agentDir = join(tmp, "agent"); mkdirSync(agentDir);
      writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { openrouter: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "synthetic-key",
        models: [MIMO, PRO].map((id) => ({ id, reasoning: true, contextWindow: 32000, maxTokens: 1024,
          compat: { thinkingFormat: "openrouter", openRouterRouting: ROUTING } })),
      }, fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "synthetic-key",
        models: [{ id: "plain", reasoning: true, contextWindow: 32000, maxTokens: 1024 }],
      } } }));
      set("PI_CODING_AGENT_DIR", agentDir); set("RUNNER_TEMP", tmp);
      set("PI_EXECUTABLE", resolve("node_modules/.bin/pi"));
      set("OPENROUTER_API_KEY", "synthetic-key");
      const inputs = { ...parseInputs(), provider: "openrouter", model: `openrouter/${MIMO}`, thinking: "high",
        openRouterProviderPreferences: undefined, openRouterReasoningModes: { [MIMO]: "enabled" as const },
        tools: "read", mode: "review", runTimeoutSeconds: 15, stallTimeoutSeconds: 0, costRates: "" };
      const [mimo, pro] = await Promise.all([MIMO, PRO].map((id, i) => runPi("synthetic parallel check", { ...inputs, model: `openrouter/${id}` }, undefined, false, { promptName: `parallel-${i}` })));
      expect(mimo.conclusion).toBe("success"); expect(pro.conclusion).toBe("success");
      expect(mimo.reasoning).toMatchObject({ requestedThinking: "high", configuredMode: "enabled", effectiveControl: "provider-default", adapted: true });
      expect(pro.reasoning).toMatchObject({ configuredMode: "effort", effectiveControl: "named-effort", effort: "high", adapted: false });
      expect(mimo.malformedLineCount).toBe(0);
      expect(requests.find((r) => r.model === MIMO)?.reasoning).toEqual({ enabled: true });
      expect(requests.find((r) => r.model === PRO)?.reasoning).toEqual({ effort: "high" });
      for (const request of requests) { expect(request.provider).toEqual(ROUTING); expect(request.tools).toBeDefined(); }
      const failure = await runPi("fail-permanent", inputs, undefined, false, { promptName: "permanent" });
      expect(failure.failureClass).toBe("provider_permanent");
      expect(metricFromPiRun(failure, "reviewer").reasoning).toEqual(mimo.reasoning);
      const models: ModelSpec[] = [MIMO, PRO].map((id) => ({ provider: "openrouter", model: `openrouter/${id}`, label: `openrouter/${id}` }));
      const job: ReviewJob = { model: models[0], lens: { id: "design", title: "Design", focus: "design" } };
      const failover = await executeLensWithRetry({ job, roster: models, deps: {
        runAttempt: (active, promptName) => runPi("test-failover", { ...inputs, model: active.model.model }, undefined, false, { promptName }),
      } });
      expect(failover.failoverUsed).toBe(true);
      expect(failover.attemptMetrics.map((a) => a.reasoning?.effectiveControl)).toEqual(["provider-default", "named-effort"]);
      expect(failover.lensResult.conclusion).toBe("success");
      expect(buildPiArgs({ ...inputs, openRouterReasoningModes: {} }, "/tmp/prompt", false).join(" ")).not.toContain("pi-openrouter-observe");
      const off = await runPi("synthetic off", { ...inputs, thinking: "off" }, undefined, false, { promptName: "off" });
      expect(off.conclusion).toBe("success");
      expect(requests.at(-1)?.reasoning).toBeUndefined();
      expect(off.reasoning).toMatchObject({ effectiveControl: "off", configuredMode: "enabled" });
      const capped = await runPi("synthetic cap", { ...inputs, reasoningMaxTokens: 64 }, undefined, false, { promptName: "cap" });
      expect(capped.conclusion).toBe("success");
      expect(requests.at(-1)?.reasoning).toEqual({ max_tokens: 64 });
      expect(capped.reasoning).toMatchObject({ effectiveControl: "max-tokens", maxTokens: 64 });
      const nonrouter = await runPi("synthetic other provider", { ...inputs, provider: "fixture", model: "fixture/plain" }, undefined, false, { promptName: "nonrouter" });
      expect(nonrouter.conclusion).toBe("success");
      expect(nonrouter.reasoning).toBeUndefined();
      expect(requests.at(-1)?.reasoning).toBeUndefined();
      const silentExtension = join(tmp, "no-observation-pi");
      writeFileSync(silentExtension, '#!/usr/bin/env node\n' +
        'console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"No findings."}],stopReason:"stop"}]}));\n');
      chmodSync(silentExtension, 0o700); set("PI_EXECUTABLE", silentExtension);
      const missing = await runPi("synthetic missing observation", inputs, undefined, false, { promptName: "missing" });
      expect(missing.conclusion).toBe("failure");
      expect(missing.failureClass).toBe("process_error");
      expect(missing.reasoning).toBeUndefined();
      expect(missing.output).toContain("Reasoning request telemetry missing");
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      server.closeAllConnections(); await new Promise<void>((ok) => server.close(() => ok()));
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60000);
});
