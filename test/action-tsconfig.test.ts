/**
 * The run step must compile elek with elek's OWN tsconfig, never the workspace's.
 *
 * The step runs with the caller's workspace (a PR checkout, when the caller checks one out) as
 * its working directory, and tsx reads tsconfig.json from the working directory by default. A
 * planted `paths` alias would then swap elek's own imports (here @actions/core) for workspace
 * code, in a step holding the provider API keys and the GitHub token (EHA DL-20261023-460).
 *
 * This executes the SHIPPED `run` command with the real tsx from node_modules against a fixture
 * action, from a workspace that plants such an alias. The positive control runs the bare
 * command the step used before, so a pass cannot mean "the plant never worked".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dir, "..");
const tsxBin = join(root, "node_modules", ".bin");

interface Step { id?: string; run?: string }
const runCommand = (): string => {
  const metadata = parseYaml(readFileSync(join(root, "action.yml"), "utf-8")) as { runs?: { steps?: Step[] } };
  const step = metadata.runs?.steps?.find((s) => s.id === "run");
  if (!step?.run) throw new Error("action.yml has no `run` step with a run command");
  return step.run;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runFromPlantedWorkspace(command: string): string {
  const dir = mkdtempSync(join(tmpdir(), "elek-tsconfig-"));
  dirs.push(dir);
  const action = join(dir, "action");
  const workspace = join(dir, "workspace");
  const core = join(action, "node_modules", "@actions", "core");
  for (const d of [join(action, "src", "entrypoints"), core, workspace]) mkdirSync(d, { recursive: true });
  copyFileSync(join(root, "tsconfig.json"), join(action, "tsconfig.json"));
  writeFileSync(join(action, "src", "entrypoints", "run.ts"), 'import { who } from "@actions/core";\nconsole.log(who());\n');
  writeFileSync(join(core, "package.json"), '{"name":"@actions/core","type":"module","main":"index.js"}');
  writeFileSync(join(core, "index.js"), 'export const who = () => "genuine";\n');
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@actions/core": ["./planted.ts"] } } }),
  );
  writeFileSync(join(workspace, "planted.ts"), 'export const who = () => "PLANTED";\n');
  const result = spawnSync("bash", ["-c", command], {
    cwd: workspace,
    encoding: "utf-8",
    env: { PATH: `${tsxBin}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_ACTION_PATH: action },
  });
  return `${result.stdout}${result.stderr}`.trim();
}

describe("the run step ignores the workspace tsconfig", () => {
  it("positive control: the bare tsx command resolves a planted paths alias", () => {
    expect(runFromPlantedWorkspace('tsx "$GITHUB_ACTION_PATH/src/entrypoints/run.ts"')).toBe("PLANTED");
  });

  it("the shipped run command resolves elek's genuine dependency", () => {
    expect(runFromPlantedWorkspace(runCommand())).toBe("genuine");
  });
});
