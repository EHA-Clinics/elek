import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitize } from "../mcp/handlers.js";

/** Preserve the full report even when the council fails before synthesis. */
export function persistReviewReport(
  tmpDir: string,
  name: string,
  report: { modelLabel: string; conclusion: "success" | "failure"; output: string },
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Invalid review report name");
  const directory = join(tmpDir, "elek-reports");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify({
    ...report,
    output: sanitize(report.output),
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
