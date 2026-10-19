/**
 * EHAC-3622 gap 1: the FINAL validator (the synthesis) fails over ONCE, to the caller-pinned
 * `validator_failover_model`, when its first attempt ends `stall` or `invalid_output`.
 *
 * Evidence: eha_care run 39038897722 (synthesis `stall` after 132.7s, 1 turn,
 * max_idle=120.1s) and run 39037993447 (synthesis `invalid_output` after 108.7s). Each
 * finalized `validator_failed` and threw away ~20 minutes of finished lens work, because
 * the synthesis was a single attempt.
 *
 * These drive the REAL orchestrator (src/entrypoints/run.ts) in a child process, with only
 * the model runner, the GitHub fetch and the comment API scripted, and read the review
 * summary it writes. The pure contract is in final-validator-failover.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const FLASH = "openrouter/deepseek/deepseek-v4.1-flash";
const PRO = "openrouter/deepseek/deepseek-v4-pro-0813";
const GLM = "openrouter/z-ai/glm-5.3-flash";

interface HarnessRun {
  exitCode: number;
  summary: {
    review: { terminalReason: string; finalModel: string; findingsCount?: number | null };
    attempts: Array<Record<string, unknown>>;
    modelRuns: Array<Record<string, unknown>>;
    retriedLensIds: string[];
  };
  calls: Array<{ promptName: string; model: string; runTimeoutSeconds: number; promptNamesModel: boolean }>;
  stdout: string;
}

/**
 * Run the real orchestrator in a child process with the model runner scripted
 * (see test/fixtures/run-harness.preload.ts). `synthesis[n]` overrides the nth
 * non-lens model run; lens runs always succeed.
 */
function runOrchestrator(params: {
  synthesis: Array<Record<string, unknown>>;
  /** Lens results by prompt name ("lens-<id>"); an unnamed lens succeeds with "No findings." */
  lenses?: Record<string, Record<string, unknown>>;
  inputs?: Record<string, string>;
  /** When the job started, in seconds before now. Default: now. */
  jobStartedSecondsAgo?: number;
}): HarnessRun {
  const dir = mkdtempSync(join(tmpdir(), "elek-harness-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: "opened",
      repository: { name: "widgets", full_name: "acme/widgets", owner: { login: "acme" }, default_branch: "main" },
      pull_request: {
        number: 7,
        title: "harness",
        body: "",
        author_association: "OWNER",
        head: { ref: "feature", sha: "a".repeat(40) },
        base: { ref: "main", sha: "b".repeat(40) },
      },
    }),
  );
  const callsPath = join(dir, "calls.jsonl");
  const inputs: Record<string, string> = {
    PROVIDER: "openrouter",
    MODEL: GLM,
    PROMPT: "review this change",
    CONFIG_PATH: "none",
    STICKY_COMMENT: "false",
    REVIEW_STRATEGY: "crosscheck",
    REVIEW_MODELS: `${GLM},${GLM}`,
    ADVISOR_MODEL: "off",
    VALIDATOR_MODEL: FLASH,
    RUN_TIMEOUT_SECONDS: "900",
    VALIDATOR_RUN_TIMEOUT_SECONDS: "1200",
    JOB_TIMEOUT_MINUTES: "65",
    STALL_TIMEOUT_SECONDS: "120",
    MAX_DEGRADED_LENSES: "1",
    SHOW_COST: "false",
    ...params.inputs,
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH || "",
    HOME: dir,
    RUNNER_TEMP: dir,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_REPOSITORY_OWNER: "acme",
    GITHUB_ACTOR: "octocat",
    GITHUB_RUN_ID: "1",
    // A placeholder: octokit is replaced in the preload and never sends it anywhere.
    GITHUB_TOKEN: "harness-placeholder",
    // When the job started, as the harness's job clock reports it.
    ELEK_HARNESS_JOB_STARTED_AT_MS: String(Date.now() - (params.jobStartedSecondsAgo ?? 0) * 1000),
    ELEK_HARNESS_SCRIPT: JSON.stringify({ synthesis: params.synthesis, lenses: params.lenses ?? {} }),
    ELEK_HARNESS_CALLS: callsPath,
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name}`] = value;

  try {
    const child = Bun.spawnSync(
      [process.execPath, "--preload", join(ROOT, "test", "fixtures", "run-harness.preload.ts"), join(ROOT, "src", "entrypoints", "run.ts")],
      { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = `${child.stdout.toString()}\n${child.stderr.toString()}`;
    const summaryPath = join(dir, "elek-review-summary.json");
    if (!existsSync(summaryPath)) throw new Error(`no review summary was written:\n${stdout}`);
    return {
      exitCode: child.exitCode ?? -1,
      summary: JSON.parse(readFileSync(summaryPath, "utf-8")),
      calls: existsSync(callsPath)
        ? readFileSync(callsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line))
        : [],
      stdout,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stall = {
  conclusion: "failure",
  failureClass: "stall",
  terminationReason: "stall",
  output: "pi stalled",
  durationSeconds: 132.7,
  turnsUsed: 1,
  maxIdleSecondsObserved: 120.1,
  lastEventType: "message_start",
};
const invalidOutput = {
  conclusion: "failure",
  failureClass: "invalid_output",
  output: "",
  durationSeconds: 108.7,
};
const timedOut = {
  conclusion: "failure",
  failureClass: "timeout",
  terminationReason: "timeout",
  output: "pi timed out",
  durationSeconds: 1200,
};

const validatorAttempts = (run: HarnessRun) =>
  run.summary.attempts
    .filter((a) => a.role === "validator")
    .map((a) => ({
      attempt: a.attempt,
      failover: a.failover,
      assignedModel: a.assignedModel,
      actualModel: a.actualModel,
      conclusion: a.conclusion,
      failureClass: a.failureClass,
    }));

describe("orchestrator end to end: the final validator fails over once (EHAC-3622)", () => {
  it.each([
    ["stall", stall],
    ["invalid_output", invalidOutput],
  ] as const)("a synthesis that ends %s on attempt 1 and succeeds on attempt 2 completes", (failureClass, first) => {
    const run = runOrchestrator({
      synthesis: [first, {}],
      inputs: { VALIDATOR_FAILOVER_MODEL: PRO },
    });

    expect(run.summary.review.terminalReason).toBe("completed");
    expect(run.exitCode).toBe(0);
    expect(validatorAttempts(run)).toEqual([
      { attempt: 1, failover: false, assignedModel: FLASH, actualModel: FLASH, conclusion: "failure", failureClass },
      { attempt: 2, failover: true, assignedModel: FLASH, actualModel: PRO, conclusion: "success", failureClass: undefined },
    ]);
    // The retry is the SYNTHESIS on the pinned model, with the same lens reports: no lens re-ran.
    expect(run.calls.filter((c) => c.promptName.startsWith("lens-"))).toHaveLength(2);
    const synthesisCalls = run.calls.filter((c) => !c.promptName.startsWith("lens-"));
    expect(synthesisCalls.map((c) => [c.promptName, c.model])).toEqual([
      ["prompt", FLASH],
      ["prompt-failover", PRO],
    ]);
    // The failover's synthesis prompt is rebuilt for the failover model, not reused.
    expect(synthesisCalls.map((c) => c.promptNamesModel)).toEqual([true, true]);
    // Early in a 65-minute job the live clock affords the full validator budget, V = 1200s.
    expect(synthesisCalls.map((c) => c.runTimeoutSeconds)).toEqual([1200, 1200]);
    expect(run.summary.attempts.filter((a) => a.role === "validator").map((a) => a.runTimeoutSeconds)).toEqual([
      undefined,
      1200,
    ]);
    // One DECISIVE validator run, carrying how it was reached.
    const decisive = run.summary.modelRuns.filter((r) => r.role === "validator");
    expect(decisive).toHaveLength(1);
    expect(decisive[0]).toMatchObject({
      modelLabel: PRO,
      assignedModelLabel: FLASH,
      actualModelLabel: PRO,
      failoverUsed: true,
      attemptCount: 2,
      conclusion: "success",
    });
    expect(run.summary.retriedLensIds).toContain("validator");
    expect(run.summary.review.finalModel).toBe(PRO);
  });

  it("both attempts failing finalizes validator_failed with BOTH attempts recorded", () => {
    const run = runOrchestrator({
      synthesis: [stall, invalidOutput, {}],
      inputs: { VALIDATOR_FAILOVER_MODEL: PRO },
    });

    expect(run.summary.review.terminalReason).toBe("validator_failed");
    expect(run.exitCode).not.toBe(0);
    expect(validatorAttempts(run).map((a) => [a.attempt, a.failover, a.actualModel, a.failureClass])).toEqual([
      [1, false, FLASH, "stall"],
      [2, true, PRO, "invalid_output"],
    ]);
    expect(run.calls.filter((c) => !c.promptName.startsWith("lens-"))).toHaveLength(2);
  });

  it("the MEASURED job clock near the cap: NO failover, and the log says why", () => {
    // The job started 3600s ago, though the action itself only just did: 3900 - 3600 - 60 = 240 < 300.
    const run = runOrchestrator({
      synthesis: [stall, {}],
      inputs: { VALIDATOR_FAILOVER_MODEL: PRO },
      jobStartedSecondsAgo: 3600,
    });

    expect(run.summary.review.terminalReason).toBe("validator_failed");
    expect(validatorAttempts(run)).toHaveLength(1);
    expect(run.calls.filter((c) => !c.promptName.startsWith("lens-"))).toHaveLength(1);
    expect(run.stdout).toContain("NOT retried: the live job clock cannot cover a failover synthesis");
  });

  it("a synthesis that ends timeout is NOT retried, even with a pinned model", () => {
    const run = runOrchestrator({
      synthesis: [timedOut, {}],
      inputs: { VALIDATOR_FAILOVER_MODEL: PRO },
    });

    expect(run.summary.review.terminalReason).toBe("validator_failed");
    expect(validatorAttempts(run)).toHaveLength(1);
    expect(run.calls.filter((c) => !c.promptName.startsWith("lens-"))).toHaveLength(1);
  });

  it("an EMPTY input is today's behaviour: one attempt, validator_failed", () => {
    const run = runOrchestrator({ synthesis: [stall, {}] });

    expect(run.summary.review.terminalReason).toBe("validator_failed");
    expect(validatorAttempts(run)).toEqual([
      { attempt: 1, failover: false, assignedModel: FLASH, actualModel: FLASH, conclusion: "failure", failureClass: "stall" },
    ]);
    expect(run.summary.modelRuns.filter((r) => r.role === "validator")[0]).toMatchObject({
      assignedModelLabel: FLASH,
      actualModelLabel: FLASH,
      failoverUsed: false,
      attemptCount: 1,
    });
    expect(run.summary.retriedLensIds).not.toContain("validator");
  });

  it("refuses validator_failover_model equal to validator_model at preflight, before any model runs", () => {
    // Same model reached another way: identity is the last two path segments.
    const run = runOrchestrator({
      synthesis: [{}],
      inputs: { VALIDATOR_FAILOVER_MODEL: "deepseek/deepseek-v4.1-flash" },
    });

    expect(run.summary.review.terminalReason).toBe("configuration_error");
    expect(run.exitCode).not.toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toContain("validator_failover_model");
  });
});

const finding = (title: string) =>
  [`### ${title}`, "- Severity: important", "- Confidence: high", "- Path: `a.ts`", "- Line: 1",
    "- Evidence: the changed line", "- Impact: wrong result", "- Fix: guard it"].join("\n");
const twoFindings = `## Findings\n\n${finding("First defect")}\n\n${finding("Second defect")}\n`;
const lensCounts = (run: HarnessRun) =>
  run.summary.modelRuns.map((r) => [r.role, r.lensId ?? null, r.findingsCount]);

/**
 * EHAC-3675 needs to know whether an ERRORED council found anything before an admin may
 * waive it. Each run records its own findings count when it finishes, so a breach or a
 * failed synthesis afterwards cannot erase it.
 */
describe("findings counts in the review summary (EHAC-3675 groundwork)", () => {
  it("a BREACHED council still records each finished lens's findings count", () => {
    // eha_care #4866 run 39234890907: the advisor hit max_turns after the lenses succeeded.
    const run = runOrchestrator({
      synthesis: [{}],
      inputs: { ADVISOR_MODEL: PRO },
      lenses: {
        "lens-risk": { output: twoFindings },
        "lens-advisor-independent-audit": { conclusion: "failure", failureClass: "max_turns", output: "pi exceeded max turns" },
      },
    });

    expect(run.summary.review.terminalReason).toBe("council_policy_breached");
    expect(lensCounts(run)).toEqual([
      ["reviewer", "risk", 2],
      ["reviewer", "design", 0],
      ["validator-review", "advisor-independent-audit", null],
    ]);
    // No synthesis ran, so there is no synthesized count; the key is still written.
    expect(run.summary.review.findingsCount).toBeNull();
  });

  it("a lens whose output cannot be read as a review records null, not 0", () => {
    const run = runOrchestrator({
      synthesis: [{}],
      lenses: { "lens-design": { output: "I looked at the change and stopped there." } },
    });

    expect(run.summary.review.terminalReason).toBe("completed");
    expect(lensCounts(run).filter(([role]) => role === "reviewer")).toEqual([
      ["reviewer", "risk", 0],
      ["reviewer", "design", null],
    ]);
  });

  it("records the synthesized review's findings count, on the summary and on the validator run", () => {
    const run = runOrchestrator({ synthesis: [{ output: `## Review\n\n${twoFindings}` }] });

    expect(run.summary.review.terminalReason).toBe("completed");
    expect(run.summary.review.findingsCount).toBe(2);
    expect(lensCounts(run).filter(([role]) => role === "validator")).toEqual([["validator", null, 2]]);
  });

  it("a FAILED synthesis records a null synthesized count and keeps the lens counts", () => {
    const run = runOrchestrator({ synthesis: [stall], lenses: { "lens-risk": { output: twoFindings } } });

    expect(run.summary.review.terminalReason).toBe("validator_failed");
    expect(run.summary.review.findingsCount).toBeNull();
    expect(lensCounts(run)).toEqual([
      ["reviewer", "risk", 2],
      ["reviewer", "design", 0],
      ["validator", null, null],
    ]);
  });
});
