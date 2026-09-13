import type { CouncilPolicyResult } from "./council-policy.js";

/** Public coverage comes from observed runs, never the synthesizer's prose. */
export function publicReviewCoverage(
  body: string,
  conclusion: "success" | "failure",
  policy?: CouncilPolicyResult,
): { body: string; status: string } {
  const status = conclusion === "failure" ? "encountered an issue"
    : policy && policy.status !== "healthy" ? "review incomplete" : "analysis complete";
  if (!policy || policy.status === "healthy") return { body, status };
  const completed = policy.reviewerLensesTotal - policy.reviewerLensesFailed;
  const missing = policy.failedReviewerLensIds.join(", ") || "none";
  const notice = [
    `> **${policy.status.toUpperCase()} REVIEW — ${completed}/${policy.reviewerLensesTotal} reviewer lenses completed.**`,
    `> Missing reviewer lenses: ${missing}.`,
    ...(policy.failedValidatorRoleIds.length ? [`> Failed validator roles: ${policy.failedValidatorRoleIds.join(", ")}.`] : []),
    ...(policy.status === "degraded" ? ["> The configured quorum was met; this is incomplete coverage."] : ["> The configured quorum was not met."]),
    ...(policy.failedReviewerLensIds.includes("tests")
      ? ["> The test integrity review did not complete. Clinical or test-heavy changes require a separate targeted test review before approval."] : []),
  ].join("\n");
  return { body: `${notice}\n\n${body}`, status };
}
