import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistReviewReport } from "../src/review/report-artifact";

describe("complete review report artifacts", () => {
  it("retains complete successful and failed attempt reports without publishing credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "elek-reports-"));
    try {
      const output = "evidence\n".repeat(20_000) + "REPORT_END";
      for (const [name, conclusion] of [["risk", "success"], ["risk-retry", "failure"], ["validator", "failure"]] as const) {
        persistReviewReport(root, name, { modelLabel: "openrouter/example", conclusion, output });
        const file = join(root, "elek-reports", `${name}.json`);
        const saved = JSON.parse(readFileSync(file, "utf8"));
        expect(saved.output).toBe(output);
        expect(saved.conclusion).toBe(conclusion);
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      const token = "ghp_" + "A".repeat(36);
      persistReviewReport(root, "secret", { modelLabel: "openrouter/example", conclusion: "success", output: `token=${token}` });
      expect(readFileSync(join(root, "elek-reports/secret.json"), "utf8").includes(token)).toBe(false);
      expect(readdirSync(join(root, "elek-reports"))).toHaveLength(4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects names that escape the artifact directory or overwrite an earlier attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "elek-reports-"));
    const report = { modelLabel: "example", conclusion: "success" as const, output: "report" };
    try {
      for (const name of ["../escape", "/absolute", "", ".", ".."]) {
        expect(() => persistReviewReport(root, name, report)).toThrow();
      }
      persistReviewReport(root, "risk", report);
      expect(() => persistReviewReport(root, "risk", report)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
