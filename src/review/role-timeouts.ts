/**
 * Per-role wall-clock resolver (EHAC-2833; extracted for testability in v1.6.1).
 *
 * A review plan has three consuming roles for per-run wall clock:
 *
 *   reviewer          - the parallel lens wave (always `run_timeout_seconds`)
 *   validator-review  - the audit lens inside that wave, AND its failover
 *                       replacement (both carry the validator budget)
 *   validator         - the final synthesis, after the wave drains
 *
 * The resolver was previously two inline closures in `run.ts` (the lens inputs
 * for validator-review jobs, and the synthesis inputs). The properties that
 * matter — reviewer gets R, validator-review gets V, a validator-review FAILOVER
 * still gets V, and the synthesis gets V — were claims about a 1200-line
 * entrypoint rather than checked facts. Extracted so the truth table is
 * unit-testable; the failover property additionally relies on
 * `executeLensWithRetry` preserving `role` on the replacement job
 * (`{ ...job, model: decision.model }`), which lens-execution.test.ts asserts.
 */

export interface RoleTimeoutInputs {
  /** The reviewer per-run cap, as passed by the caller. */
  runTimeoutSeconds: number;
  /**
   * The validator roles' per-run cap, as passed by the caller. ABSENT (undefined)
   * when the caller does not set `validator_run_timeout_seconds`, which resolves
   * both validator roles to `runTimeoutSeconds` — byte-identical to pre-EHAC-2833
   * behaviour.
   */
  validatorRunTimeoutSeconds?: number;
}

export interface RoleTimeouts {
  /** Reviewer lenses. Always `runTimeoutSeconds`. */
  reviewer: number;
  /** The validator-review audit lens and its failover replacement. */
  validatorReview: number;
  /** The final synthesis. */
  validator: number;
}

/**
 * Resolve the per-role wall clock. Pure; no I/O, no `core`, no process state.
 */
export function resolveRoleTimeouts({
  runTimeoutSeconds,
  validatorRunTimeoutSeconds,
}: RoleTimeoutInputs): RoleTimeouts {
  const validatorSeconds = validatorRunTimeoutSeconds ?? runTimeoutSeconds;
  return {
    reviewer: runTimeoutSeconds,
    validatorReview: validatorSeconds,
    validator: validatorSeconds,
  };
}
