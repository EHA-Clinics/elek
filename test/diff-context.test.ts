import { describe, expect, it } from "bun:test";
import {
  applyExcludePaths,
  diffPromptBudgetChars,
  formatChangedFilesForPrompt,
  globToRegExp,
  modelInputBudgetChars,
  parseUnifiedDiffFiles,
  promptPriority,
} from "../src/review/diff-context";

describe("diff prompt context", () => {
  it("parses changed files and line counts from unified diffs", () => {
    const diff = [
      "diff --git a/src/a.go b/src/a.go",
      "--- a/src/a.go",
      "+++ b/src/a.go",
      "@@ -1,2 +1,3 @@",
      " package main",
      "-old()",
      "+new()",
      "+extra()",
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-docs",
    ].join("\n");
    const files = parseUnifiedDiffFiles(diff);

    expect(files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }))).toEqual([
      { path: "src/a.go", status: "modified", additions: 2, deletions: 1 },
      { path: "README.md", status: "deleted", additions: 0, deletions: 1 },
    ]);
    expect(formatChangedFilesForPrompt(diff, 10_000)).toContain("# Changed file overview (2 files");
    expect(formatChangedFilesForPrompt(diff, 10_000)).toContain("# Full diff");
  });

  it("keeps later application files visible when early docs deletions are huge", () => {
    const hugeReadmeDeletion = Array.from({ length: 3_000 }, (_, i) => `-deleted docs ${i}`).join("\n");
    const diff = [
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1,3000 +0,0 @@",
      hugeReadmeDeletion,
      "diff --git a/src/server.go b/src/server.go",
      "--- a/src/server.go",
      "+++ b/src/server.go",
      "@@ -10,2 +10,3 @@",
      " func serve() error {",
      "+  return validateTenant()",
      " }",
    ].join("\n");

    const out = formatChangedFilesForPrompt(diff, 5_000);

    expect(out).toContain("# Changed file overview (2 files");
    expect(out).toContain("# - README.md (deleted");
    expect(out).toContain("# - src/server.go (modified");
    expect(out).toContain("diff --git a/src/server.go b/src/server.go");
    expect(out).toContain("+  return validateTenant()");
    expect(out).toContain("diff truncated by file for prompt budget");
  });

  it("keeps the full diff whenever it fits the selected model budget", () => {
    const largeGeneratedFile = Array.from({ length: 9_000 }, (_, i) => `+generated line ${i}`).join("\n");
    const diff = [
      "diff --git a/docs/generated.md b/docs/generated.md",
      "--- a/docs/generated.md",
      "+++ b/docs/generated.md",
      "@@ -1 +1,9000 @@",
      largeGeneratedFile,
      "diff --git a/src/auth/server.go b/src/auth/server.go",
      "--- a/src/auth/server.go",
      "+++ b/src/auth/server.go",
      "@@ -10,2 +10,4 @@",
      " func lookup() {",
      "+  query := db.User.First()",
      "+  _ = query",
      " }",
    ].join("\n");

    const out = formatChangedFilesForPrompt(diff, 200_000);

    expect(diff.length).toBeLessThan(200_000);
    expect(out).toContain("# Changed file overview (2 files");
    expect(out).toContain("# Full diff");
    expect(out).not.toContain("# Representative diff slices");
    expect(out).toContain("diff --git a/src/auth/server.go b/src/auth/server.go");
    expect(out).toContain("+  query := db.User.First()");
    expect(out).toContain("+generated line 8999");
  });

  it("uses model-aware input budgets with only an explicit reserve", () => {
    expect(modelInputBudgetChars("together/zai-org/GLM-5.2")).toBe(540_000);
    expect(modelInputBudgetChars("openai/gpt-5.6-sol")).toBe(700_000);
    expect(modelInputBudgetChars("together/moonshotai/Kimi-K3")).toBe(2_700_000);
    expect(diffPromptBudgetChars("together/zai-org/GLM-5.2", 40_000)).toBe(500_000);
    expect(diffPromptBudgetChars("unknown/model", 20_000)).toBe(300_000);
  });
});

describe("exclude_paths filtering", () => {
  const fileDiff = (path: string, body: string) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,2 @@",
      ` context`,
      `+${body}`,
    ].join("\n");

  describe("globToRegExp", () => {
    it("lets **/ match zero leading directory segments", () => {
      const rx = globToRegExp("**/fixtures/**");
      expect(rx.test("fixtures/patient.json")).toBe(true);
      expect(rx.test("a/b/fixtures/patient.json")).toBe(true);
      expect(rx.test("src/fixturesque/a.ts")).toBe(false);
    });

    it("does not let * cross a path separator", () => {
      const rx = globToRegExp("src/*.ts");
      expect(rx.test("src/a.ts")).toBe(true);
      expect(rx.test("src/nested/a.ts")).toBe(false);
    });

    it("treats ? as a single non-separator character and . as a literal", () => {
      expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
      expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
      expect(globToRegExp("a.ts").test("axts")).toBe(false);
    });

    it("compiles unsupported brace globs to a pattern that matches nothing", () => {
      // Documented limitation — assert it rather than let it surprise someone.
      expect(globToRegExp("**/*.{ts,tsx}").test("src/a.ts")).toBe(false);
    });
  });

  describe("applyExcludePaths", () => {
    it("partitions files by glob and keeps everything when no globs are given", () => {
      const files = parseUnifiedDiffFiles(
        [fileDiff("src/app.ts", "keep"), fileDiff(".planning/notes.md", "drop")].join("\n"),
      );
      expect(applyExcludePaths(files, []).kept).toHaveLength(2);
      const { kept, excluded } = applyExcludePaths(files, [".planning/**"]);
      expect(kept.map((f) => f.path)).toEqual(["src/app.ts"]);
      expect(excluded.map((f) => f.path)).toEqual([".planning/notes.md"]);
    });

    it("keeps a rename that moves a file OUT of an excluded tree", () => {
      const renamed = {
        path: "src/app.ts",
        oldPath: ".planning/app.ts",
        status: "renamed" as const,
        additions: 1,
        deletions: 0,
        patch: "diff --git a/.planning/app.ts b/src/app.ts",
      };
      expect(applyExcludePaths([renamed], [".planning/**"]).kept).toHaveLength(1);
    });
  });

  it("removes excluded file contents AND overview entries from the prompt", () => {
    const diff = [
      fileDiff("src/app.ts", "REVIEWABLE_TOKEN"),
      fileDiff(".planning/secret.md", "EXCLUDED_TOKEN"),
    ].join("\n");
    const packed = formatChangedFilesForPrompt(diff, 320_000, { excludePaths: [".planning/**"] });
    expect(packed).toContain("REVIEWABLE_TOKEN");
    expect(packed).not.toContain("EXCLUDED_TOKEN");
    expect(packed).not.toContain(".planning/secret.md");
    expect(packed).toContain("1 changed file(s) excluded");
  });

  it("does not leak excluded content through the FULL-diff path", () => {
    // Regression guard: the full-diff branch used to embed the raw diff string,
    // which would re-admit every excluded file after filtering the file list.
    const diff = [
      fileDiff("src/app.ts", "REVIEWABLE_TOKEN"),
      fileDiff("secrets/creds.txt", "EXCLUDED_TOKEN"),
    ].join("\n");
    const packed = formatChangedFilesForPrompt(diff, 1_000_000, { excludePaths: ["secrets/**"] });
    expect(packed).toContain("# Full diff");
    expect(packed).not.toContain("EXCLUDED_TOKEN");
  });

  it("withholds an unparseable diff rather than transmitting it unfiltered", () => {
    const unparseable = "this text contains no diff --gi headers at all";
    expect(formatChangedFilesForPrompt(unparseable, 320_000, { excludePaths: ["x/**"] })).not.toContain(
      "no diff --gi headers",
    );
    // Without exclude_paths there is nothing to honour, so the old behaviour stands.
    expect(formatChangedFilesForPrompt(unparseable, 320_000)).toContain("no diff --gi headers");
  });

  it("reports zero reviewable files when everything is excluded", () => {
    const diff = fileDiff(".planning/a.md", "EXCLUDED_TOKEN");
    const packed = formatChangedFilesForPrompt(diff, 320_000, { excludePaths: [".planning/**"] });
    expect(packed).not.toContain("EXCLUDED_TOKEN");
    expect(packed).toContain("0 reviewable files");
  });

  it("reclaims prompt budget so real source is shown in full (the PR #362 shape)", () => {
    // Large excluded artifacts + one small source file, under a budget far too
    // small to hold both. This is the exact starvation that produced
    // PARTIAL_SOURCE: the source file was shown at 5-15%.
    const noise = Array.from({ length: 20 }, (_, i) =>
      fileDiff(`.planning/capture-${i}.py`, "X".repeat(4_000)),
    );
    const source = fileDiff("src/app.ts", "REVIEWABLE_TOKEN_" + "Y".repeat(3_000));
    const diff = [...noise, source].join("\n");
    const budget = 20_000;

    const before = formatChangedFilesForPrompt(diff, budget);
    const after = formatChangedFilesForPrompt(diff, budget, { excludePaths: [".planning/**"] });

    // Before: the source file is truncated by the per-file slice budget.
    expect(before).toContain("file diff truncated");
    // After: it fits whole, and none of the excluded content is present.
    expect(after).toContain("REVIEWABLE_TOKEN_" + "Y".repeat(3_000));
    expect(after).not.toContain(".planning/capture-0.py");
  });

  it("is byte-identical to the pre-patch behaviour when no exclude_paths are set", () => {
    const diff = [fileDiff("src/a.ts", "one"), fileDiff("docs/b.md", "two")].join("\n");
    expect(formatChangedFilesForPrompt(diff, 320_000, {})).toBe(
      formatChangedFilesForPrompt(diff, 320_000),
    );
    expect(formatChangedFilesForPrompt(diff, 320_000, { excludePaths: [] })).toBe(
      formatChangedFilesForPrompt(diff, 320_000),
    );
  });
});

describe("priority_source_extensions (opt-in)", () => {
  const file = (path: string) => ({
    path,
    oldPath: path,
    status: "modified" as const,
    additions: 1,
    deletions: 0,
    patch: `diff --git a/${path} b/${path}`,
  });

  it("treats an infra repo's real source as priority 2 by DEFAULT", () => {
    // The motivating problem: a pure-Terraform repo ships nothing the built-in
    // list calls production source, so it has NO priority-0 files at all and a
    // coverage check that only considers priority 0 can essentially never fail.
    expect(promptPriority(file("infra/main.tf"))).toBe(2);
    expect(promptPriority(file("deploy/values.yaml"))).toBe(2);
    expect(promptPriority(file("app/Component.vue"))).toBe(2);
    // Language source is priority 0 with or without the opt-in.
    expect(promptPriority(file("src/app.ts"))).toBe(0);
  });

  it("promotes only the extensions a repo opts into", () => {
    expect(promptPriority(file("infra/main.tf"), ["tf", "tfvars"])).toBe(0);
    expect(promptPriority(file("infra/vars.tfvars"), ["tf", "tfvars"])).toBe(0);
    // Not opted in — unchanged.
    expect(promptPriority(file("deploy/values.yaml"), ["tf", "tfvars"])).toBe(2);
  });

  it("accepts extensions with or without a leading dot, case-insensitively", () => {
    expect(promptPriority(file("infra/main.tf"), [".TF"])).toBe(0);
    expect(promptPriority(file("infra/MAIN.TF"), ["tf"])).toBe(0);
  });

  it("never promotes tests or docs, even when their extension is opted in", () => {
    // The test/docs checks run BEFORE the extension check, so opting an
    // extension in cannot smuggle a test or doc file into priority 0.
    expect(promptPriority(file("infra/tests/main.tf"), ["tf"])).toBe(1);
    expect(promptPriority(file("docs/notes.md"), ["md"])).toBe(4);
    // Pre-existing upstream quirk, asserted so the opt-in is not blamed for it:
    // isTestCode matches "/tests/", so a REPO-ROOT tests/ directory is not
    // recognised as test code and an opted-in extension there does reach
    // priority 0. Unchanged by this patch; true of .ts files today.
    expect(promptPriority(file("tests/main.ts"))).toBe(0);
    expect(promptPriority(file("tests/main.tf"), ["tf"])).toBe(0);
  });

  it("keeps deleted-file priorities unchanged", () => {
    const deleted = { ...file("infra/main.tf"), status: "deleted" as const };
    expect(promptPriority(deleted, ["tf"])).toBe(5);
  });

  it("orders opted-in source ahead of other files in the packed prompt", () => {
    const mk = (path: string, body: string) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,2 @@", " ctx", `+${body}`].join("\n");
    const diff = [mk("z-notes.txt", "X".repeat(9_000)), mk("infra/main.tf", "TF_TOKEN")].join("\n");
    const budget = 9_500;
    const withOptIn = formatChangedFilesForPrompt(diff, budget, { productionExtensions: ["tf"] });
    expect(withOptIn).toContain("TF_TOKEN");
  });
});
