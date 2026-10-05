import { describe, expect, it } from "bun:test";
import { diffPromptBudgetChars, formatChangedFilesForPrompt, modelInputBudgetChars } from "../src/review/diff-context";
import { buildLensPrompt, buildSynthesisPrompt, parseModelSpec } from "../src/review/strategy";
import type { GitHubData } from "../src/github/data";

const models = [
  "openrouter/z-ai/glm-5.3-flash",
  "openrouter/xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5-pro",
  "openrouter/deepseek/deepseek-v4.1-flash",
  "openrouter/deepseek/deepseek-v4-pro-0813",
];
const lens = { id: "risk", title: "Risk", focus: "Correctness" };
// Reproduce the large source-bearing diff that the old 320K fallback sliced.
// Generated locally: no application source or private PR discussion in fixtures.
const diff = Array.from({ length: 57 }, (_, i) => [
  `diff --git a/src/module${i}.py b/src/module${i}.py`,
  `--- a/src/module${i}.py`, `+++ b/src/module${i}.py`,
  "@@ -0,0 +1,400 @@", ...Array.from({ length: 400 }, (_, j) => `+value_${j} = "${"x".repeat(24)}"`),
  `+sentinel_${i} = "end-of-file"`,
].join("\n")).join("\n");
const data: GitHubData = {
  type: "pr", title: "Large runtime change", body: "b".repeat(20_000), author: "alice", diff,
  comments: ["c".repeat(10_000)], reviewComments: ["r".repeat(10_000)], labels: [], assignees: [],
  entityNumber: 1, pr: { headRef: "fix/runtime", baseRef: "main" },
};

describe("verified OpenRouter council context", () => {
  it("exercises a diff larger than the previous fallback capacity", () => {
    expect(diff.length).toBeGreaterThan(803_385);
    expect(diff.length).toBeLessThan(1_030_000);
  });
  for (const model of models) {
    it(`delivers complete source and reserved reports for ${model}`, () => {
      const modelLabel = parseModelSpec(model, "openrouter").label;
      const prompt = buildLensPrompt({ data, userRequest: "Review", lens, modelLabel });
      const synthesis = buildSynthesisPrompt({ data, userRequest: "Review", modelLabel,
        jobRunLink: "https://example.test/run", reports: Array.from({ length: 5 }, (_, i) => ({
          lens: { ...lens, id: `lens-${i}` }, modelLabel, conclusion: "success" as const,
          output: `report-${i}:` + "e".repeat(16_000),
        })),
      });
      for (const text of [prompt, synthesis]) {
        expect(text.includes(diff)).toBe(true);
        expect(text).not.toContain("diff truncated");
        expect(text.length).toBeLessThan(modelInputBudgetChars(modelLabel));
      }
      for (let i = 0; i < 5; i++) expect(synthesis).toContain(`report-${i}:` + "e".repeat(16_000));
    });
    it(`retains honest truncation on overflow for ${model}`, () => {
      const budget = diffPromptBudgetChars(model, 500_000);
      const packed = formatChangedFilesForPrompt(diff, budget);
      expect(packed).toContain("diff truncated");
      expect(packed.length).toBeLessThanOrEqual(budget);
      expect(packed.includes(diff)).toBe(false);
    });
  }
  it("keeps unknown providers, lookalikes and fallback models conservative", () => {
    for (const model of ["deepseek/deepseek-v4.1-flash", "other/z-ai/glm-5.3-flash",
      "openrouter/z-ai/glm-5.3-flash-preview", "unknown/model", "openrouter/xiaomi/mimo-v2.5"]) {
      expect(modelInputBudgetChars(model)).toBe(320_000);
      expect(formatChangedFilesForPrompt(diff, diffPromptBudgetChars(model, 70_000))).toContain("diff truncated");
    }
    expect(modelInputBudgetChars("together/moonshotai/Kimi-K3")).toBe(2_700_000);
    expect(modelInputBudgetChars("openai/gpt-5.6-sol")).toBe(700_000);
    expect(modelInputBudgetChars("together/zai-org/GLM-5.2")).toBe(540_000);
  });
});
