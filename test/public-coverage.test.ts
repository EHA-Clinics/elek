import { describe, expect, it } from "bun:test";
import { evaluateCouncilPolicy } from "../src/review/council-policy";
import { parseReviewLensList } from "../src/review/strategy";
import { publicReviewCoverage } from "../src/review/public-coverage";

const council = (failed: string[]) => evaluateCouncilPolicy({
  configuredMaxDegradedLenses: 1,
  runs: ["risk", "design", "ops", "tests"].map((lensId) => ({
    role: "reviewer", lensId, conclusion: failed.includes(lensId) ? "failure" : "success",
  })),
});

describe("public review coverage", () => {
  it("recognizes the actual canonical test integrity lens", () => {
    const [lens] = parseReviewLensList("tests");
    const review = publicReviewCoverage("No findings.", "success", council([lens.id]));
    expect(lens.title).toContain("Test");
    expect(review.body).toContain("test integrity review did not complete");
  });
  it("leads even a long clean synthesis with the observed missing tests coverage", () => {
    const review = publicReviewCoverage("All clear. ".repeat(1000), "success", council(["tests"]));
    expect(review.status).toBe("review incomplete");
    expect(review.body.startsWith("> **DEGRADED REVIEW — 3/4 reviewer lenses completed.")).toBe(true);
    expect(review.body.slice(0, 1000)).toContain("separate targeted test review before approval");
    expect(review.body).toContain("configured quorum was met");
  });
  it("does not claim the tests lens failed when a different lens failed", () => {
    const review = publicReviewCoverage("No findings.", "success", council(["ops"]));
    expect(review.body).toContain("Missing reviewer lenses: ops");
    expect(review.body).not.toContain("test integrity review did not complete");
  });
  it("retains an unusable synthesis failure even with a tolerated dropout", () => {
    const review = publicReviewCoverage("No usable output", "failure", council(["tests"]));
    expect(review.status).toBe("encountered an issue");
    expect(review.body).toContain("DEGRADED REVIEW");
    expect(review.body).toContain("No usable output");
  });
  it("does not label healthy or non-council output degraded", () => {
    for (const policy of [undefined, council([])]) {
      expect(publicReviewCoverage("No findings.", "success", policy)).toEqual({ body: "No findings.", status: "analysis complete" });
    }
  });
  it("distinguishes breached from tolerated coverage", () => {
    const review = publicReviewCoverage("Partial findings", "failure", council(["tests", "risk"]));
    expect(review.body).toContain("BREACHED REVIEW — 2/4");
    expect(review.body).toContain("quorum was not met");
  });
});
