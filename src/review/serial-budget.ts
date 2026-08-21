/**
 * Serial wall-clock budget guard (EHAC-2280, AC #4).
 *
 * A council does NOT run its lenses and its validator concurrently: the validator
 * runs AFTER the reviewer lenses. So the serial worst case for one job is
 *
 *     setup + reviewer_cap + validator_cap  =  setup + 2 * run_timeout_seconds
 *
 * and if that exceeds the job's own `timeout-minutes`, the runner cancels the job
 * mid-flight. A cancelled job loses the coverage record ENTIRELY — the required
 * check goes red with `verdict: UNKNOWN`, no findings, and nothing to action. That
 * is strictly worse than an honest red, and it is what EHAC-2280 observed four
 * times on 2026-08-21.
 *
 * This module makes that arithmetic a precondition, checked before any model runs,
 * so the failure is a legible configuration error instead of a guillotine 30
 * minutes later.
 *
 * WHY THREE OUTCOMES AND NOT TWO. `job_timeout_minutes` has no default: a caller
 * that never sets it passes an empty string. A two-outcome guard would report
 * "pass" for every such caller — which is most of the fleet — and a check that
 * reports success when it has not checked anything is a gate that cannot fail.
 * The third outcome, `unchecked`, exists so that absence is REPORTED as absence.
 */

/**
 * Wall-clock consumed before the first model run: checkout, toolchain setup,
 * dependency install, prompt assembly.
 *
 * 37s is the CONSERVATIVE prose value recorded in
 * `EHA-Clinics/.github@c69fe14 ai-code-review.yml:255-258`. It is deliberately
 * NOT the measured value: live measurement on the three runs cited by EHAC-2280
 * was 6s (32481049135), 7s (32476228482) and 22s (32489358013). 37 errs safe and
 * is retained for that reason. Do not restate it as measured on those runs.
 */
export const SETUP_SECONDS = 37;

export interface SerialBudgetInput {
  runTimeoutSeconds: number;
  /** Absent when the caller does not pass `job_timeout_minutes`. */
  jobTimeoutMinutes: number | undefined;
  setupSeconds?: number;
}

export interface SerialBudgetAssessment {
  outcome: "pass" | "fail" | "unchecked";
  message: string;
}

/**
 * Pure assessment. No I/O, no `core`, no process state — so the whole truth table
 * is unit-testable, including the branch that is hardest to test and easiest to
 * fake: `unchecked`.
 */
export function assessSerialBudget({
  runTimeoutSeconds,
  jobTimeoutMinutes,
  setupSeconds = SETUP_SECONDS,
}: SerialBudgetInput): SerialBudgetAssessment {
  const required = setupSeconds + 2 * runTimeoutSeconds;

  if (jobTimeoutMinutes === undefined) {
    return {
      outcome: "unchecked",
      message:
        "Serial wall-clock budget NOT CHECKED: this caller does not pass `job_timeout_minutes`, " +
        `so elek cannot see the job cap it would be checked against. The serial worst case here is ` +
        `${setupSeconds}s setup + 2 x ${runTimeoutSeconds}s (reviewer lenses, then the validator) = ${required}s. ` +
        "Pass `job_timeout_minutes` from the caller to have this asserted. Until then a job cancelled " +
        "by the outer cap will lose its coverage record with no warning beyond this line.",
    };
  }

  const capSeconds = jobTimeoutMinutes * 60;

  if (required > capSeconds) {
    return {
      outcome: "fail",
      message:
        "Serial wall-clock budget EXCEEDED — refusing to start, because a job cancelled by the outer " +
        "cap loses its coverage record entirely and reports no findings at all.\n" +
        `  run_timeout_seconds : ${runTimeoutSeconds}\n` +
        `  job_timeout_minutes : ${jobTimeoutMinutes}\n` +
        `  serial worst case   : ${setupSeconds} + 2 x ${runTimeoutSeconds} = ${required}s\n` +
        `  job cap             : ${jobTimeoutMinutes} x 60 = ${capSeconds}s\n` +
        `  ${required}s > ${capSeconds}s\n` +
        "The validator runs AFTER the reviewer lenses, so two full per-run budgets can elapse back " +
        "to back. Raise `job_timeout_minutes` FIRST, then `run_timeout_seconds` — never the reverse.",
    };
  }

  return {
    outcome: "pass",
    message:
      `Serial wall-clock budget checked: ${setupSeconds} + 2 x ${runTimeoutSeconds} = ${required}s ` +
      `<= ${jobTimeoutMinutes} x 60 = ${capSeconds}s.`,
  };
}

/**
 * The reporter surface this guard needs. In production this is `@actions/core`
 * itself; in tests it is a spy. Injecting it is what lets the `unchecked` branch
 * be asserted by observing that a warning was actually emitted, rather than by the
 * vacuous "it did not throw".
 */
export interface SerialBudgetReporter {
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
}

/**
 * Report an assessment and say whether the run may proceed.
 *
 * `unchecked` continues — an absent input is not a misconfiguration, and refusing
 * to run would break every consumer that has not adopted the input yet. But it
 * continues LOUDLY, and the emitted text never claims the budget is fine.
 */
export function reportSerialBudget(
  assessment: SerialBudgetAssessment,
  reporter: SerialBudgetReporter,
): "continue" | "abort" {
  switch (assessment.outcome) {
    case "fail":
      reporter.setFailed(assessment.message);
      return "abort";
    case "unchecked":
      reporter.warning(assessment.message);
      return "continue";
    default:
      reporter.info(assessment.message);
      return "continue";
  }
}
