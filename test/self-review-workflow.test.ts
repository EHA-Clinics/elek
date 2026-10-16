/**
 * elek's own advisory self-review (.github/workflows/elek.yml), owner ruling 8 (EHAC-2844).
 *
 * Every lane runs an OpenRouter model the account guardrail allows, through the org
 * OPENROUTER_API_KEY only. The former direct-DeepSeek lane referenced a secret this repo
 * does not have, and kimi-k2.7-code is blocked by the guardrail, so both lanes failed on
 * every run. Model ids keep the `openrouter/` prefix: without it pi resolves the native
 * provider and fails with "No API key".
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

interface Step {
  uses?: string;
  with?: Record<string, string>;
}
interface Job {
  "continue-on-error"?: boolean;
  steps: Step[];
}

const raw = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "elek.yml"), "utf-8");
const workflow = YAML.parse(raw) as { jobs: Record<string, Job> };
const lanes = Object.entries(workflow.jobs).map(([id, job]) => {
  const step = job.steps.find((s) => s.uses === "./");
  if (!step?.with) throw new Error(`job ${id} has no elek step`);
  return { id, job, inputs: step.with };
});

describe("elek self-review workflow (ruling 8)", () => {
  it("runs exactly the two OpenRouter lanes, with prefixed model ids", () => {
    expect(lanes.map((l) => l.inputs.model).sort()).toEqual([
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/xiaomi/mimo-v2.6-pro",
    ]);
    for (const { id, inputs } of lanes) {
      expect({ id, provider: inputs.provider }).toEqual({ id, provider: "openrouter" });
    }
  });

  it("uses the org OPENROUTER_API_KEY and no other secret", () => {
    for (const { id, inputs } of lanes) {
      expect({ id, key: inputs.openrouter_api_key }).toEqual({ id, key: "${{ secrets.OPENROUTER_API_KEY }}" });
    }
    expect([...new Set(raw.match(/secrets\.[A-Za-z_]+/g))]).toEqual(["secrets.OPENROUTER_API_KEY"]);
  });

  it("caps mimo-v2.6-pro reasoning in enabled mode, as the council runs it", () => {
    const mimo = lanes.find((l) => l.inputs.model === "openrouter/xiaomi/mimo-v2.6-pro");
    expect(JSON.parse(mimo!.inputs.openrouter_model_reasoning_modes)).toEqual({
      "xiaomi/mimo-v2.6-pro": { mode: "enabled", max_tokens: 12000 },
    });
  });

  it("keeps every lane advisory", () => {
    for (const { id, job } of lanes) {
      expect({ id, advisory: job["continue-on-error"] }).toEqual({ id, advisory: true });
    }
  });
});
