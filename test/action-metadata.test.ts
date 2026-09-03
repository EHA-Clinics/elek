import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

interface CompositeStep {
  id?: string;
  env?: Record<string, string>;
}

interface ActionMetadata {
  inputs?: Record<string, unknown>;
  runs?: {
    steps?: CompositeStep[];
  };
}

describe("composite action input contract", () => {
  it("maps every core.getInput consumed by parseInputs into the TypeScript run step", () => {
    const root = join(import.meta.dir, "..");
    const source = readFileSync(join(root, "src", "github", "context.ts"), "utf-8");
    const metadata = parseYaml(readFileSync(join(root, "action.yml"), "utf-8")) as ActionMetadata;
    const inputNames = [
      ...new Set([...source.matchAll(/core\.getInput\("([a-z0-9_]+)"\)/g)].map((match) => match[1])),
    ];
    const runStep = metadata.runs?.steps?.find((step) => step.id === "run");

    expect(inputNames.length).toBeGreaterThan(0);
    expect(runStep).toBeDefined();

    for (const inputName of inputNames) {
      expect(metadata.inputs?.[inputName]).toBeDefined();
      expect(runStep?.env?.[`INPUT_${inputName.toUpperCase()}`]).toBe(`\${{ inputs.${inputName} }}`);
    }

    for (const [environmentName, expression] of Object.entries(runStep?.env ?? {})) {
      if (!environmentName.startsWith("INPUT_")) continue;
      const match = /^\$\{\{ inputs\.([a-z0-9_]+) \}\}$/.exec(expression);
      expect(match, `${environmentName} must map directly to one declared action input`).not.toBeNull();
      expect(metadata.inputs?.[match?.[1] ?? ""]).toBeDefined();
    }
  });
});
