import { expect, it } from "bun:test";
import { boundCouncilOutput, councilOutputLimit } from "../src/council-output";
import { buildPiArgs } from "../src/pi";
import { parseInputs } from "../src/github/context";

const models = ["z-ai/glm-5.3-flash", "xiaomi/mimo-v2.5-pro", "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro-0813"];
for (const id of models) {
  it(`reserves input headroom without changing reasoning or source for ${id}`, () => {
    const model = { provider: "openrouter", id };
    for (const field of ["max_tokens", "max_completion_tokens"]) {
      const payload = { [field]: 831740, messages: [{ content: "complete source" }], tools: [], reasoning: { effort: "high" } };
      const bounded = boundCouncilOutput(payload, model)!;
      expect(bounded).toEqual({ ...payload, [field]: 131072 });
      expect(bounded.messages).toBe(payload.messages);
      expect(bounded.reasoning).toBe(payload.reasoning);
      expect(payload[field]).toBe(831740);
      expect(boundCouncilOutput({ [field]: 1024 }, model)).toBeUndefined();
    }
    expect(boundCouncilOutput({}, model)).toEqual({ max_tokens: 131072 });
  });
  it(`loads the mandatory output-bound extension without reasoning overrides for ${id}`, () => {
    const args = buildPiArgs({ ...parseInputs(), provider: "openrouter", model: `openrouter/${id}`, openRouterReasoningModes: {}, reasoningMaxTokens: undefined }, "/tmp/prompt", false);
    expect(args.join(" ")).toContain("pi-openrouter-observe.ts");
  });
}
it("leaves other providers and lookalike models unchanged", () => {
  for (const [provider, id] of [["other", models[0]], ["openrouter", models[0] + "-preview"], ["deepseek", models[2]]]) {
    expect(councilOutputLimit(provider, id)).toBeUndefined();
    expect(boundCouncilOutput({ max_tokens: 900000 }, { provider, id })).toBeUndefined();
  }
});
