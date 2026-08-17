/**
 * Council policy — the tolerance decision, in both directions.
 *
 * Every case below is paired: a known-bad shape that must breach, next to the
 * known-good shape that must not. A passing test on its own proves only that the
 * evaluator returns something.
 */
import { describe, expect, it } from "bun:test";
import {
  effectiveMaxDegraded,
  evaluateCouncilPolicy,
  type CouncilPolicyRun,
} from "../src/review/council-policy";

const reviewer = (lensId: string, conclusion: "success" | "failure"): CouncilPolicyRun => ({
  role: "reviewer",
  lensId,
  modelLabel: `model-${lensId}`,
  conclusion,
});
const advisor = (conclusion: "success" | "failure"): CouncilPolicyRun => ({
  role: "validator-review",
  lensId: "validator-self-review",
  modelLabel: "validator-model",
  conclusion,
});

const FOUR_HEALTHY = [
  reviewer("risk", "success"),
  reviewer("design", "success"),
  reviewer("tests", "success"),
  reviewer("operations", "success"),
];

describe("effectiveMaxDegraded", () => {
  it("passes a tolerance that leaves at least one reviewer standing", () => {
    expect(effectiveMaxDegraded(1, 4).effective).toBe(1);
    expect(effectiveMaxDegraded(0, 4).effective).toBe(0);
  });

  it("clamps to strict — never to total-1 — when the tolerance could wipe the panel", () => {
    const four = effectiveMaxDegraded(4, 4);
    expect(four.effective).toBe(0);
    expect(four.warning).toContain("no surviving reviewer");
    expect(effectiveMaxDegraded(9, 4).effective).toBe(0);
    // A single-reviewer council cannot tolerate anything at all.
    expect(effectiveMaxDegraded(1, 1).effective).toBe(0);
  });

  it("clamps a nonsensical value to strict rather than to the default", () => {
    expect(effectiveMaxDegraded(-1, 4).effective).toBe(0);
    expect(effectiveMaxDegraded(1.5, 4).effective).toBe(0);
  });
});

describe("evaluateCouncilPolicy", () => {
  it("is healthy when nothing dropped", () => {
    const result = evaluateCouncilPolicy({
      runs: [...FOUR_HEALTHY, advisor("success")],
      configuredMaxDegradedLenses: 1,
    });
    expect(result.status).toBe("healthy");
    expect(result.message).toBeNull();
    expect(result.reviewerLensesFailed).toBe(0);
  });

  it("is degraded — not breached — for one reviewer dropout at tolerance 1", () => {
    const result = evaluateCouncilPolicy({
      runs: [reviewer("risk", "success"), reviewer("design", "success"), reviewer("tests", "failure"), reviewer("operations", "success"), advisor("success")],
      configuredMaxDegradedLenses: 1,
    });
    expect(result.status).toBe("degraded");
    expect(result.failedReviewerLensIds).toEqual(["tests"]);
    // The census leads, then the rule. Naming only the decisive run hides damage.
    expect(result.message).toContain("1 of 5 council model run(s) did not succeed");
    expect(result.message).toContain("tests");
    expect(result.message).toContain("within the tolerance of 1");
  });

  it("breaches on the SAME record at tolerance 0", () => {
    const runs = [reviewer("risk", "success"), reviewer("design", "success"), reviewer("tests", "failure"), reviewer("operations", "success"), advisor("success")];
    expect(evaluateCouncilPolicy({ runs, configuredMaxDegradedLenses: 0 }).status).toBe("breached");
  });

  it("breaches on two reviewer dropouts at tolerance 1", () => {
    const result = evaluateCouncilPolicy({
      runs: [reviewer("risk", "failure"), reviewer("design", "success"), reviewer("tests", "failure"), reviewer("operations", "success"), advisor("success")],
      configuredMaxDegradedLenses: 1,
    });
    expect(result.status).toBe("breached");
    expect(result.message).toContain("above the tolerance of 1");
  });

  it("breaches on a failed validator-review regardless of tolerance", () => {
    for (const tolerance of [0, 1, 2, 3]) {
      const result = evaluateCouncilPolicy({
        runs: [...FOUR_HEALTHY, advisor("failure")],
        configuredMaxDegradedLenses: tolerance,
      });
      expect(result.status).toBe("breached");
      expect(result.message).toContain("validator role did not succeed");
    }
  });

  it("breaches when every reviewer failed, however permissive the input", () => {
    const result = evaluateCouncilPolicy({
      runs: [reviewer("risk", "failure"), reviewer("design", "failure"), advisor("success")],
      configuredMaxDegradedLenses: 99,
    });
    expect(result.status).toBe("breached");
    expect(result.effectiveMaxDegradedLenses).toBe(0);
    expect(result.message).toContain("No reviewer lens succeeded");
  });

  it("breaches on a failed run whose role cannot be weighed", () => {
    const result = evaluateCouncilPolicy({
      runs: [...FOUR_HEALTHY, { role: "mystery", lensId: "who", modelLabel: "m", conclusion: "failure" }],
      configuredMaxDegradedLenses: 1,
    });
    expect(result.status).toBe("breached");
    expect(result.message).toContain("neither reviewer nor validator");
    expect(result.unclassifiedRunLabels).toEqual(["who (m -> failure)"]);
  });

  it("breaches on a failed run with NO role at all", () => {
    const result = evaluateCouncilPolicy({
      runs: [...FOUR_HEALTHY, { lensId: "roleless", modelLabel: "m", conclusion: "failure" }],
      configuredMaxDegradedLenses: 1,
    });
    expect(result.status).toBe("breached");
  });

  it("reports configured and effective tolerance separately so drift is visible", () => {
    const result = evaluateCouncilPolicy({ runs: FOUR_HEALTHY, configuredMaxDegradedLenses: 7 });
    expect(result.configuredMaxDegradedLenses).toBe(7);
    expect(result.effectiveMaxDegradedLenses).toBe(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("treats an empty run list as healthy — zero runs is judged elsewhere", () => {
    // Deliberate: "no runs" is not "no failures". The summary's terminal reason
    // and the downstream gate decide whether zero runs is legitimate; conflating
    // the two here would let an empty record look like a clean council.
    const result = evaluateCouncilPolicy({ runs: [], configuredMaxDegradedLenses: 1 });
    expect(result.status).toBe("healthy");
    expect(result.reviewerLensesTotal).toBe(0);
  });
});
