/**
 * EHAC-3622: the job clock the final-validator failover is gated on. The failover may only
 * spend what the job cap provably leaves, so the job's START must be measured, not assumed.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import {
  measuredJobElapsedSeconds,
  parseProcStat,
  runnerWorkerStartedAtMs,
  type JobClockDeps,
} from "../src/review/job-clock";

const BOOT = 1_760_000_000; // epoch seconds
const NOW = (BOOT + 10_000) * 1000;

/** `/proc/<pid>/stat` with only the fields the parser reads filled in. */
function stat(pid: number, comm: string, ppid: number, startTicks: number): string {
  const after = ["S", String(ppid), ...Array.from({ length: 17 }, () => "0"), String(startTicks), "0", "0"];
  return `${pid} (${comm}) ${after.join(" ")}`;
}

function procDeps(processes: Record<number, string>, overrides: Partial<JobClockDeps> = {}): JobClockDeps {
  const files: Record<string, string> = { "/proc/stat": `cpu 1 2 3\nbtime ${BOOT}\nprocesses 9\n` };
  for (const [pid, content] of Object.entries(processes)) files[`/proc/${pid}/stat`] = content;
  return {
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
    pid: 400,
    clockTicksPerSecond: () => 100,
    now: () => NOW,
    ...overrides,
  };
}

// node (400) -> node (300, tsx) -> bash (200) -> Runner.Worker (100, started 9000s after boot)
const RUNNER_TREE = {
  400: stat(400, "node", 300, 980_000),
  300: stat(300, "node", 200, 979_000),
  200: stat(200, "bash", 100, 978_000),
  100: stat(100, "Runner.Worker", 50, 900_000),
  50: stat(50, "Runner.Listener", 1, 100),
};

describe("parseProcStat", () => {
  it("reads comm, ppid and start ticks, even when comm contains spaces and parentheses", () => {
    expect(parseProcStat(stat(7, "a (b) c", 3, 1234))).toEqual({ comm: "a (b) c", ppid: 3, startTicks: 1234 });
  });

  it("refuses a malformed line", () => {
    expect(parseProcStat("garbage")).toBeUndefined();
    expect(parseProcStat("7 (x) S")).toBeUndefined();
  });
});

describe("runnerWorkerStartedAtMs", () => {
  it("finds the Runner.Worker ancestor and converts its start to epoch time", () => {
    expect(runnerWorkerStartedAtMs(procDeps(RUNNER_TREE))).toBe((BOOT + 9000) * 1000);
  });

  it("is undefined with no worker ancestor, no /proc, or no clock-tick rate", () => {
    const { 100: _worker, ...noWorker } = RUNNER_TREE;
    expect(runnerWorkerStartedAtMs(procDeps({ ...noWorker, 200: stat(200, "bash", 1, 978_000) }))).toBeUndefined();
    expect(runnerWorkerStartedAtMs({ ...procDeps(RUNNER_TREE), readFile: () => { throw new Error("ENOENT"); } })).toBeUndefined();
    expect(runnerWorkerStartedAtMs(procDeps(RUNNER_TREE, { clockTicksPerSecond: () => undefined }))).toBeUndefined();
  });
});

describe("measuredJobElapsedSeconds", () => {
  it("uses the worker's start", () => {
    expect(measuredJobElapsedSeconds(procDeps(RUNNER_TREE))).toBe(1000);
  });

  it("is undefined when the job's start cannot be measured at all", () => {
    expect(measuredJobElapsedSeconds(procDeps({}))).toBeUndefined();
    // A worker start in the future (clock skew) is not a measurement.
    expect(measuredJobElapsedSeconds(procDeps(RUNNER_TREE, { now: () => (BOOT + 8000) * 1000 }))).toBeUndefined();
  });

  // Live evidence, on a real GitHub-hosted Linux runner only (elek's own CI): this test
  // process descends from the job's Runner.Worker, which must be found, and must have
  // started before this process and within the CI job's 15-minute cap.
  it.if(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux")(
    "finds the job's Runner.Worker on a real GitHub runner",
    () => {
      const elapsed = measuredJobElapsedSeconds({
        readFile: (path) => readFileSync(path, "utf-8"),
        pid: process.pid,
        clockTicksPerSecond: () => Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8" }).trim()),
        now: () => Date.now(),
      });
      expect(elapsed).toBeDefined();
      expect(elapsed!).toBeGreaterThanOrEqual(process.uptime());
      expect(elapsed!).toBeLessThan(15 * 60);
    },
  );
});
