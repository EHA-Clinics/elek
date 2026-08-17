/**
 * Council policy: how many reviewer lenses may drop and the review still count.
 *
 * This replaces `failedRequiredReviewLensIds().length > 0` as the DECISION (that
 * helper stays, as the census it always was). A boolean "did anything fail" scores
 * a redundancy mechanism as a serial reliability chain: with six runs a single
 * dropout blocks the pull request, which makes a council strictly less reliable
 * than the least reliable model in it. Four eha_care pull requests — including a
 * tenant-isolation security fix — were blocked simultaneously that way.
 *
 * The rules below are deliberately the SAME rules the downstream coverage gate
 * applies, evaluated independently on each side from the same observed runs. That
 * is the point: two independent derivations of one policy value, not one
 * derivation trusted twice.
 *
 * Never tolerated, at any tolerance:
 *   - a failed run whose role is neither reviewer nor validator (cannot be weighed)
 *   - a failed validator role (nothing reconciled the findings)
 *   - a wiped reviewer panel (nothing read the diff)
 *   - more failed reviewer lenses than the effective tolerance
 */

export type CouncilPolicyStatus = "healthy" | "degraded" | "breached";

/** Roles that may consume the degraded-lens budget. */
export const REVIEWER_ROLES = Object.freeze(["reviewer"]);
/** Roles that may NOT: their failure means the review was never reconciled. */
export const VALIDATOR_ROLES = Object.freeze(["validator", "validator-review"]);

export interface CouncilPolicyRun {
  role?: string;
  lensId?: string;
  modelLabel?: string;
  conclusion: "success" | "failure";
}

export interface CouncilPolicyResult {
  status: CouncilPolicyStatus;
  configuredMaxDegradedLenses: number;
  effectiveMaxDegradedLenses: number;
  reviewerLensesTotal: number;
  reviewerLensesFailed: number;
  failedReviewerLensIds: string[];
  failedValidatorRoleIds: string[];
  unclassifiedRunLabels: string[];
  /** Full census plus the rule-specific reason. Null when healthy. */
  message: string | null;
  /** Non-fatal notes, e.g. a tolerance clamped for being too wide to mean anything. */
  warnings: string[];
}

const label = (run: CouncilPolicyRun) =>
  `${run.lensId ?? run.role ?? "(unknown)"} (${run.modelLabel ?? "unknown model"} -> ${run.conclusion})`;

/**
 * Normalize the configured tolerance, ALWAYS in the strict direction.
 *
 * A tolerance greater than or equal to the reviewer count would permit a council
 * with no surviving reviewer, which is not a degraded review — it is no review.
 * Clamping to 0 rather than to `total - 1` is deliberate: a value that far out is
 * a misconfiguration, and a misconfigured knob must never end up widening what
 * the review accepts.
 */
export function effectiveMaxDegraded(configured: number, reviewerLensesTotal: number): {
  effective: number;
  warning?: string;
} {
  if (!Number.isInteger(configured) || configured < 0) {
    return {
      effective: 0,
      warning: `max_degraded_lenses resolved to a non-integer or negative value (${configured}); using 0 (strict).`,
    };
  }
  if (reviewerLensesTotal > 0 && configured >= reviewerLensesTotal) {
    return {
      effective: 0,
      warning:
        `max_degraded_lenses=${configured} is not below the reviewer lens count (${reviewerLensesTotal}), ` +
        "so it would permit a council with no surviving reviewer; using 0 (strict).",
    };
  }
  return { effective: configured };
}

export function evaluateCouncilPolicy(params: {
  runs: readonly CouncilPolicyRun[];
  configuredMaxDegradedLenses: number;
}): CouncilPolicyResult {
  const runs = params.runs ?? [];
  const failed = runs.filter((r) => r.conclusion !== "success");
  const reviewers = runs.filter((r) => REVIEWER_ROLES.includes(String(r.role)));
  const failedReviewers = reviewers.filter((r) => r.conclusion !== "success");
  const failedValidators = failed.filter((r) => VALIDATOR_ROLES.includes(String(r.role)));
  const failedUnclassified = failed.filter(
    (r) => !REVIEWER_ROLES.includes(String(r.role)) && !VALIDATOR_ROLES.includes(String(r.role)),
  );

  const { effective, warning } = effectiveMaxDegraded(
    params.configuredMaxDegradedLenses,
    reviewers.length,
  );
  const warnings = warning ? [warning] : [];

  const base = {
    configuredMaxDegradedLenses: params.configuredMaxDegradedLenses,
    effectiveMaxDegradedLenses: effective,
    reviewerLensesTotal: reviewers.length,
    reviewerLensesFailed: failedReviewers.length,
    failedReviewerLensIds: failedReviewers.map((r) => r.lensId ?? r.role ?? "(unknown)"),
    failedValidatorRoleIds: failedValidators.map((r) => r.lensId ?? r.role ?? "(unknown)"),
    unclassifiedRunLabels: failedUnclassified.map(label),
    warnings,
  };

  if (failed.length === 0) {
    return { ...base, status: "healthy", message: null };
  }

  // Every outcome leads with the SAME full census and only then gives the
  // rule-specific reason. Naming just the decisive run hides the rest of the
  // damage from whoever has to diagnose it.
  const census = `${failed.length} of ${runs.length} council model run(s) did not succeed: ${failed.map(label).join(", ")}.`;

  if (failedUnclassified.length > 0) {
    return {
      ...base,
      status: "breached",
      message: `${census} ${failedUnclassified.length} of them carry a role that is neither reviewer nor validator, and an unclassifiable run cannot be weighed against the tolerance, so it fails closed.`,
    };
  }
  if (failedValidators.length > 0) {
    return {
      ...base,
      status: "breached",
      message: `${census} A validator role did not succeed, so nothing independently audited or reconciled the lens findings.`,
    };
  }
  if (reviewers.length > 0 && failedReviewers.length >= reviewers.length) {
    return {
      ...base,
      status: "breached",
      message: `${census} No reviewer lens succeeded — nothing read the diff.`,
    };
  }
  if (failedReviewers.length > effective) {
    return {
      ...base,
      status: "breached",
      message: `${census} That is ${failedReviewers.length} of ${reviewers.length} reviewer lens(es), above the tolerance of ${effective}, so the council did not reach quorum.`,
    };
  }
  return {
    ...base,
    status: "degraded",
    message: `${census} That is ${failedReviewers.length} of ${reviewers.length} reviewer lens(es), within the tolerance of ${effective}. The review is thinner than the strategy name implies: repeated degradation is a defect to chase, not a steady state to accept.`,
  };
}
