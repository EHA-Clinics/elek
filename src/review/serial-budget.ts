/**
 * Serial wall-clock budget guard (EHAC-2280, AC #4; EHAC-2833 revision).
 *
 * A council does NOT run its lenses and its validator concurrently: the final
 * validator runs AFTER the reviewer wave. The wave itself runs the reviewer
 * lenses AND the `validator-review` audit lens in parallel. So the serial worst
 * case for one job is
 *
 *     setup + max(2 x reviewer_cap, 2 x validator_cap) + validator_cap
 *
 * where the DOUBLE cap is the reach of the ONE permitted outer retry
 * (`MAX_LENS_ATTEMPTS = 2`): an attempt plus a failover on the worst job in the
 * wave, then the final synthesis after the wave drains. `timeout` never retries
 * (falsified at eha_care #3680), so the realistic bound is a single cap per
 * phase — but the guard asserts the retry-reachable bound, because a retry is
 * exactly the thing a future change re-enables and a green guard must not be
 * quietly understating the ceiling it claims to have checked.
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
  /**
   * The validator roles' per-run cap, as passed by the caller. ABSENT (undefined)
   * when the caller does not set `validator_run_timeout_seconds`, which resolves
   * to `runTimeoutSeconds` — and to TODAY'S ARITHMETIC (see `assess`).
   */
  validatorRunTimeoutSeconds?: number;
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
  validatorRunTimeoutSeconds,
  jobTimeoutMinutes,
  setupSeconds = SETUP_SECONDS,
}: SerialBudgetInput): SerialBudgetAssessment {
  // BYTE-IDENTICAL WHEN UNSET. A caller that has not opted into the validator
  // budget is asserted against exactly the formula this guard shipped with
  // (`setup + 2 * run_timeout_seconds`). Using the full retry-reachable formula
  // with V resolved to R would demand `setup + 3R` from every consumer that has
  // not adopted the new input, refusing previously-green callers at preflight.
  // The residual that formula covers (a slow provider_unavailable burning a full
  // cap before its failover) exists for the reviewer wave TOO and predates this
  // input — it is the documented accepted residual, not a new gap this change
  // introduces.
  const validatorSeconds = validatorRunTimeoutSeconds ?? runTimeoutSeconds;
  const required =
    validatorRunTimeoutSeconds === undefined
      ? setupSeconds + 2 * runTimeoutSeconds
      : setupSeconds +
        Math.max(2 * runTimeoutSeconds, 2 * validatorSeconds) +
        validatorSeconds;

  if (jobTimeoutMinutes === undefined) {
    return {
      outcome: "unchecked",
      message:
        "Serial wall-clock budget NOT CHECKED: this caller does not pass `job_timeout_minutes`, " +
        `so elek cannot see the job cap it would be checked against. The serial worst case here is ` +
        `${setupSeconds}s setup + ${validatorRunTimeoutSeconds === undefined ? `2 x ${runTimeoutSeconds}s` : `max(2 x ${runTimeoutSeconds}s reviewer, 2 x ${validatorSeconds}s validator-review) + ${validatorSeconds}s validator`} = ${required}s. ` +
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
        `  validator_run_timeout_seconds : ${validatorRunTimeoutSeconds === undefined ? "(unset — inherits the reviewer budget)" : validatorSeconds}\n` +
        `  job_timeout_minutes : ${jobTimeoutMinutes}\n` +
        `  serial worst case   : ${setupSeconds} + ${validatorRunTimeoutSeconds === undefined ? `2 x ${runTimeoutSeconds}` : `max(2 x ${runTimeoutSeconds} reviewer, 2 x ${validatorSeconds} validator-review) + ${validatorSeconds} validator`} = ${required}s\n` +
        `  job cap             : ${jobTimeoutMinutes} x 60 = ${capSeconds}s\n` +
        `  ${required}s > ${capSeconds}s\n` +
        "The validator runs AFTER the reviewer lenses, so two full per-run budgets can elapse back " +
        "to back. Raise `job_timeout_minutes` FIRST, then the per-run budgets — never the reverse.",
    };
  }

  return {
    outcome: "pass",
    message:
      `Serial wall-clock budget checked: ${setupSeconds} + ` +
      `${validatorRunTimeoutSeconds === undefined ? `2 x ${runTimeoutSeconds}` : `max(2 x ${runTimeoutSeconds} reviewer, 2 x ${validatorSeconds} validator-review) + ${validatorSeconds} validator`} ` +
      `= ${required}s <= ${jobTimeoutMinutes} x 60 = ${capSeconds}s.`,
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
