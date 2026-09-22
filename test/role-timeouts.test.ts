/**
 * Tests for the per-role wall-clock resolver (EHAC-2833; extracted EHAC-2841).
 *
 * The routing claims that were previously two inline closures in `run.ts`:
 *
 *   reviewer lens            -> run_timeout_seconds            (R)
 *   validator-review lens    -> validator_run_timeout_seconds  (V)
 *   validator-review FAILOVER-> V (same role branch, replacement preserves role)
 *   final synthesis          -> V
 *
 * The failover property is a JOINT claim: the resolver maps by role, and
 * `executeLensWithRetry` builds the replacement job as `{ ...job, model }`,
 * preserving `role` (asserted in lens-execution.test.ts). The synthesis inputs
 * in run.ts read `roleTimeouts.validator` directly. This file asserts the
 * resolver's truth table; the callers' wiring is asserted by the run.ts
 * closures reading exactly these fields.
 */
import { describe, it, expect } from "bun:test";
import { resolveRoleTimeouts } from "../src/review/role-timeouts";

describe("resolveRoleTimeouts", () => {
  it("gives the reviewer exactly run_timeout_seconds", () => {
    const t = resolveRoleTimeouts({ runTimeoutSeconds: 900, validatorRunTimeoutSeconds: 1200 });
    expect(t.reviewer).toBe(900);
  });

  it("gives the validator-review audit lens the validator budget", () => {
    const t = resolveRoleTimeouts({ runTimeoutSeconds: 900, validatorRunTimeoutSeconds: 1200 });
    expect(t.validatorReview).toBe(1200);
  });

  it("gives the final synthesis the validator budget", () => {
    const t = resolveRoleTimeouts({ runTimeoutSeconds: 900, validatorRunTimeoutSeconds: 1200 });
    expect(t.validator).toBe(1200);
  });

  it("resolves BOTH validator roles to the same number when the input is set", () => {
    // The audit lens and the synthesis must share one budget: a mismatch would
    // make the serial guard's `+ V` term describe a wall clock the synthesis
    // does not actually run under.
    const t = resolveRoleTimeouts({ runTimeoutSeconds: 600, validatorRunTimeoutSeconds: 1200 });
    expect(t.validatorReview).toBe(t.validator);
    expect(t.validatorReview).toBe(1200);
  });

  it("is BYTE-IDENTICAL when the validator input is unset: all roles get R", () => {
    const t = resolveRoleTimeouts({ runTimeoutSeconds: 900 });
    expect(t).toEqual({ reviewer: 900, validatorReview: 900, validator: 900 });
    expect(t).toEqual(resolveRoleTimeouts({ runTimeoutSeconds: 900, validatorRunTimeoutSeconds: undefined }));
  });

  it("is pure: same inputs, same outputs", () => {
    const a = resolveRoleTimeouts({ runTimeoutSeconds: 600, validatorRunTimeoutSeconds: 1200 });
    const b = resolveRoleTimeouts({ runTimeoutSeconds: 600, validatorRunTimeoutSeconds: 1200 });
    expect(a).toEqual(b);
  });

  // ── Failover property ───────────────────────────────────────────────────────
  //
  // `executeLensWithRetry` substitutes `{ ...job, model: decision.model }` on a
  // failover, which preserves `role`. The resolver maps by role, so the retry
  // attempt resolves the same validator budget as the first attempt — that is
  // the "failover still gets V" claim. This test documents the contract from
  // both sides: the resolver maps by role, and a role-preserving replacement
  // therefore cannot change the resolved timeout.

  it("maps strictly by role, so a role-preserving failover resolves the same budget", () => {
    const timeouts = resolveRoleTimeouts({ runTimeoutSeconds: 900, validatorRunTimeoutSeconds: 1200 });
    // Simulate the run.ts lens-inputs branch against the assigned job and the
    // failover replacement lens-execution actually builds (`{ ...job, model }`).
    const assigned = { role: "validator-review" as const, model: { label: "m/one" } };
    const replaced = { ...assigned, model: { label: "m/two" } };
    const resolveFor = (job: { role: "reviewer" | "validator-review" }) =>
      job.role === "validator-review" ? timeouts.validatorReview : timeouts.reviewer;
    expect(replaced.role).toBe(assigned.role);
    expect(resolveFor(replaced)).toBe(1200);
    expect(resolveFor(replaced)).toBe(resolveFor(assigned));
    expect(resolveFor(assigned)).not.toBe(timeouts.reviewer);
  });
});
