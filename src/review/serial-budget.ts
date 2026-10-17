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
 * wave, then the final synthesis after the wave drains. The guard asserts that
 * retry-reachable bound, because a green guard must not quietly understate the
 * ceiling it claims to have checked.
 *
 * A reviewer `timeout` retries once since owner ruling 4 (2026-10-16), on a
 * SHORTER per-attempt budget from `resolveTimeoutRetrySeconds` below: at most
 * R/2, so it always fits the 2R allowance asserted here, and never more than the
 * live clock leaves before the validator, so it cannot push the job past its cap.
 * This pre-run guard is therefore unchanged by it.
 *
 * EHAC-2522 is that re-enable for the validator-review lane: a pinned
 * `validator_review_failover_model` retries `invalid_output`, a class that can
 * arrive late (470.6s on eha_care #4710). Pinning it therefore switches the guard
 * to the retry-aware formula even when the validator budget is unset.
 *
 * EHAC-3622's final-validator failover (`validator_failover_model`) does NOT enter this
 * guard. It runs only on what the live clock provably leaves (`resolveSynthesisRetrySeconds`),
 * so it cannot push the job past its cap, and counting a fourth full budget here would
 * refuse the org's own config (37 + max(2 x 900, 2 x 1200) + 1200 + 1200 = 4837s > 65 x 60).
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
   *
   * Deliberately NOT normalized: setting this EXPLICITLY EQUAL to
   * `run_timeout_seconds` is an opt-in to the validator budget and is asserted
   * against the STRICTER retry-aware formula (`setup + 3R`), not the legacy
   * `setup + 2R` the unset form keeps. Equality of the two numbers does not make
   * the two configurations identical. (EHAC-2841)
   */
  validatorRunTimeoutSeconds?: number;
  /**
   * True when the caller pinned `validator_review_failover_model` (EHAC-2522).
   * That failover is the retry-reachable second validator-review attempt made
   * REAL for a slow class: #4710's invalid_output arrived after 470.6s, not in
   * the seconds a 404 takes. So it switches the guard to the retry-aware formula
   * even when `validatorRunTimeoutSeconds` is unset (V resolves to R: `setup +
   * 3R`). Absent/false keeps every existing bound byte-identical.
   */
  validatorReviewFailoverConfigured?: boolean;
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
  validatorReviewFailoverConfigured = false,
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
  const legacy = validatorRunTimeoutSeconds === undefined && !validatorReviewFailoverConfigured;
  const required = legacy
    ? setupSeconds + 2 * runTimeoutSeconds
    : setupSeconds + Math.max(2 * runTimeoutSeconds, 2 * validatorSeconds) + validatorSeconds;
  const formulaWithUnits = legacy
    ? `2 x ${runTimeoutSeconds}s`
    : `max(2 x ${runTimeoutSeconds}s reviewer, 2 x ${validatorSeconds}s validator-review) + ${validatorSeconds}s validator`;
  const formula = legacy
    ? `2 x ${runTimeoutSeconds}`
    : `max(2 x ${runTimeoutSeconds} reviewer, 2 x ${validatorSeconds} validator-review) + ${validatorSeconds} validator`;
  // Said only when it applies, so an unconfigured caller's text is unchanged.
  const failoverNote = validatorReviewFailoverConfigured
    ? " (validator_review_failover_model is set, so the second validator-review attempt is counted)"
    : "";

  if (jobTimeoutMinutes === undefined) {
    return {
      outcome: "unchecked",
      message:
        "Serial wall-clock budget NOT CHECKED: this caller does not pass `job_timeout_minutes`, " +
        `so elek cannot see the job cap it would be checked against. The serial worst case here is ` +
        `${setupSeconds}s setup + ${formulaWithUnits} = ${required}s${failoverNote}. ` +
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
        `  serial worst case   : ${setupSeconds} + ${formula} = ${required}s${failoverNote}\n` +
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
      `${formula} ` +
      `= ${required}s <= ${jobTimeoutMinutes} x 60 = ${capSeconds}s${failoverNote}.`,
  };
}

/** Safety margin kept free after a timeout retry and the validator. */
export const TIMEOUT_RETRY_MARGIN_SECONDS = 60;
/** A timeout retry shorter than this is not worth starting: it fails closed instead. */
export const TIMEOUT_RETRY_MIN_SECONDS = 120;

export interface TimeoutRetryBudgetInput {
  /** R: the reviewer per-run cap the timed-out attempt had. */
  runTimeoutSeconds: number;
  /** V: the resolved validator budget (`V ?? R`); undefined means R. */
  validatorSeconds?: number;
  /** The job's own cap; undefined when the caller does not pass `job_timeout_minutes`. */
  jobTimeoutMinutes: number | undefined;
  /** Wall clock already spent inside the action, from its start. */
  elapsedSeconds: number;
  setupSeconds?: number;
  marginSeconds?: number;
  minSeconds?: number;
}

/**
 * The per-attempt wall clock for the ONE timeout retry (owner ruling 4, EHAC-2844).
 *
 *   T2 = min(floor(R / 2), jobTimeoutMinutes x 60 - setup - elapsed - V - margin)
 *
 * The second term is what the job can still afford: the final synthesis (V) and a
 * margin must still fit after the retry. Returns undefined, meaning NO retry, when
 * the job cap is unknown (nothing can be proven to fit) or T2 is below
 * `minSeconds`. Pure; the caller supplies `elapsedSeconds` from its own clock.
 *
 * Evidence: 39 timeout attempts in 682 council records (2026-10-06..16), 35 of them
 * xiaomi/mimo-v2.5-pro on the design lens, all FIRST attempts at exactly 900s and
 * never retried, while the other lenses of the same runs finished (median ~300s).
 */
export function resolveTimeoutRetrySeconds({
  runTimeoutSeconds,
  validatorSeconds,
  jobTimeoutMinutes,
  elapsedSeconds,
  setupSeconds = SETUP_SECONDS,
  marginSeconds = TIMEOUT_RETRY_MARGIN_SECONDS,
  minSeconds = TIMEOUT_RETRY_MIN_SECONDS,
}: TimeoutRetryBudgetInput): number | undefined {
  if (jobTimeoutMinutes === undefined) return undefined;
  const v = validatorSeconds ?? runTimeoutSeconds;
  if (![runTimeoutSeconds, v, jobTimeoutMinutes, elapsedSeconds].every(Number.isFinite)) return undefined;
  const half = Math.floor(runTimeoutSeconds / 2);
  const remaining = Math.floor(jobTimeoutMinutes * 60 - setupSeconds - elapsedSeconds - v - marginSeconds);
  const t2 = Math.min(half, remaining);
  return t2 >= minSeconds ? t2 : undefined;
}

/**
 * The smallest wall clock worth giving the ONE final-validator failover (EHAC-3622).
 *
 * 300s covers 92% (94 of 102) of the successful deepseek-v4-pro-0813 final syntheses in
 * eha_care councils on 2026-10-15 (median 108.6s, p90 264.9s, max 1023.5s) and every
 * one of the 15 successful deepseek-v4.1-flash syntheses on 2026-10-17 (max 196.9s).
 * The lens floor of 120s would cover only 53% of the former: a retry that short mostly
 * spends money to time out. A configured validator budget below 300s lowers the floor to
 * that budget, because the retry never needs more than the first attempt had.
 */
export const SYNTHESIS_RETRY_MIN_SECONDS = 300;

export interface SynthesisRetryBudgetInput {
  /** V: the resolved validator budget the first synthesis attempt ran on. */
  validatorSeconds: number;
  /** The job's own cap; undefined when the caller does not pass `job_timeout_minutes`. */
  jobTimeoutMinutes: number | undefined;
  /** Wall clock already spent inside the action, from its start, read when attempt 1 ended. */
  elapsedSeconds: number;
  setupSeconds?: number;
  marginSeconds?: number;
  minSeconds?: number;
}

/**
 * The per-attempt wall clock for the ONE final-validator failover (EHAC-3622).
 *
 *   S2 = min(V, jobTimeoutMinutes x 60 - setup - elapsed - margin)
 *
 * The synthesis is the last model run, so nothing after it needs reserving beyond the
 * margin (posting the review, draining inline comments, the caller's coverage steps:
 * 4s on eha_care run 39038897722). Reading the LIVE clock is what makes this safe
 * without touching the pre-run serial guard: the guard asserts the worst case with no
 * failover, and the failover only ever spends what is provably left. No assumption is
 * made about how long the failed attempt took — a stall can arrive after 120s or after
 * most of V.
 *
 * Returns undefined, meaning NO retry, when the job cap is unknown (nothing can be
 * proven to fit) or S2 is below `min(minSeconds, V)`. Pure; the caller supplies
 * `elapsedSeconds` from its own clock.
 */
export function resolveSynthesisRetrySeconds({
  validatorSeconds,
  jobTimeoutMinutes,
  elapsedSeconds,
  setupSeconds = SETUP_SECONDS,
  marginSeconds = TIMEOUT_RETRY_MARGIN_SECONDS,
  minSeconds = SYNTHESIS_RETRY_MIN_SECONDS,
}: SynthesisRetryBudgetInput): number | undefined {
  if (jobTimeoutMinutes === undefined) return undefined;
  if (![validatorSeconds, jobTimeoutMinutes, elapsedSeconds].every(Number.isFinite)) return undefined;
  const v = Math.floor(validatorSeconds);
  const remaining = Math.floor(jobTimeoutMinutes * 60 - setupSeconds - elapsedSeconds - marginSeconds);
  const s2 = Math.min(v, remaining);
  return s2 >= Math.min(minSeconds, v) && s2 > 0 ? s2 : undefined;
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
