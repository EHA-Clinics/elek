/**
 * When did the JOB start? (EHAC-3622)
 *
 * The final-validator failover may only spend what the job cap provably leaves, and the
 * action's own start is not the job's: checkout, toolchain setup and `npm ci` run before
 * it, for however long they take. Two measurements are accepted, and the EARLIEST wins,
 * because an earlier start only shrinks the failover budget:
 *
 *   1. The start time of the `Runner.Worker` ancestor process. The GitHub runner's
 *      listener spawns one worker per job, and the worker spawns every step's process, so
 *      its start precedes the job's own timeout clock. Linux `/proc` only.
 *   2. `ELEK_JOB_STARTED_AT` (epoch seconds), for runners where (1) is unavailable
 *      (containers, macOS, Windows): a first step can record it with
 *      `echo "ELEK_JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"`.
 *
 * Not the event payload's mtime: the runner rewrites `event.json` before every action
 * (actions/runner `ActionRunner.cs`, `WriteWebhookPayload`), so it dates the step, not
 * the job. With neither measurement the job start is unknown, and the failover does not
 * run.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

export interface JobClockDeps {
  readFile: (path: string) => string;
  pid: number;
  /** Clock ticks per second (`getconf CLK_TCK`); undefined when it cannot be read. */
  clockTicksPerSecond: () => number | undefined;
  env: Record<string, string | undefined>;
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
    env: process.env,
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

/** `ELEK_JOB_STARTED_AT` as epoch milliseconds, when it is a plausible past instant. */
export function configuredJobStartedAtMs(deps: Pick<JobClockDeps, "env" | "now">): number | undefined {
  const raw = deps.env.ELEK_JOB_STARTED_AT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const ms = Number(raw) * 1000;
  return Number.isSafeInteger(ms) && ms <= deps.now() ? ms : undefined;
}

/**
 * Seconds since the job started, from the EARLIEST available measurement, or undefined
 * when the job's start cannot be measured.
 */
export function measuredJobElapsedSeconds(deps: JobClockDeps = defaultDeps()): number | undefined {
  const starts = [runnerWorkerStartedAtMs(deps), configuredJobStartedAtMs(deps)].filter(
    (ms): ms is number => ms !== undefined && Number.isFinite(ms) && ms <= deps.now(),
  );
  if (starts.length === 0) return undefined;
  return (deps.now() - Math.min(...starts)) / 1000;
}
