/**
 * When did the JOB start? (EHAC-3622)
 *
 * The final-validator failover may only spend what the job cap provably leaves, and the
 * action's own start is not the job's: checkout, toolchain setup and `npm ci` run before
 * it, for however long they take.
 *
 * The one accepted measurement is the start time of the `Runner.Worker` ancestor process.
 * The GitHub runner's listener spawns one worker per job, the worker sets the job up and
 * spawns every step's process, so its start precedes the job's own timeout clock (Linux
 * `/proc`; verified on a GitHub-hosted ubuntu runner by test/job-clock.test.ts in elek CI).
 *
 * Rejected on purpose, because each can start AFTER the job's clock and so overstate what
 * is left:
 *   - the event payload's mtime: the runner rewrites `event.json` before every action
 *     (actions/runner `ActionRunner.cs`, `WriteWebhookPayload`);
 *   - a timestamp written by a first step: it misses the job's own set-up.
 *
 * Without a worker ancestor (a `container:` job, macOS, Windows) the job's start is
 * unknown, and the failover does not run.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

export interface JobClockDeps {
  readFile: (path: string) => string;
  pid: number;
  /** Clock ticks per second (`getconf CLK_TCK`); undefined when it cannot be read. */
  clockTicksPerSecond: () => number | undefined;
  now: () => number;
}

const MAX_ANCESTORS = 32;
const WORKER_COMM = "Runner.Worker";

function defaultDeps(): JobClockDeps {
  return {
    readFile: (path) => readFileSync(path, "utf-8"),
    pid: process.pid,
    clockTicksPerSecond: () => {
      try {
        const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim());
        return Number.isFinite(ticks) && ticks > 0 ? ticks : undefined;
      } catch {
        return undefined;
      }
    },
    now: () => Date.now(),
  };
}

/** `/proc/<pid>/stat` -> comm, ppid and start time (clock ticks since boot). */
export function parseProcStat(stat: string): { comm: string; ppid: number; startTicks: number } | undefined {
  // comm is parenthesised and may itself contain spaces or parentheses: split on the LAST ")".
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state), so field N is rest[N - 3].
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isInteger(ppid) || !Number.isFinite(startTicks)) return undefined;
  return { comm: stat.slice(open + 1, close), ppid, startTicks };
}

/** Epoch milliseconds at which the `Runner.Worker` ancestor started, or undefined. */
export function runnerWorkerStartedAtMs(deps: JobClockDeps): number | undefined {
  try {
    const btimeLine = deps.readFile("/proc/stat").split("\n").find((line) => line.startsWith("btime "));
    const bootSeconds = Number(btimeLine?.split(/\s+/)[1]);
    if (!Number.isFinite(bootSeconds)) return undefined;
    let pid = deps.pid;
    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
      const stat = parseProcStat(deps.readFile(`/proc/${pid}/stat`));
      if (!stat) return undefined;
      if (stat.comm === WORKER_COMM) {
        const ticks = deps.clockTicksPerSecond();
        return ticks === undefined ? undefined : (bootSeconds + stat.startTicks / ticks) * 1000;
      }
      pid = stat.ppid;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Seconds since the job started, or undefined when the job's start cannot be measured. */
export function measuredJobElapsedSeconds(deps: JobClockDeps = defaultDeps()): number | undefined {
  const startedAt = runnerWorkerStartedAtMs(deps);
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt > deps.now()) return undefined;
  return (deps.now() - startedAt) / 1000;
}
