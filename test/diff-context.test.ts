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

  it("still ENDS WITH the verbatim diff in the full regime when nothing is excluded", () => {
    // Load-bearing structural property, asserted directly rather than by comparing
    // this implementation against itself.
    //
    // Consumers identify the full-diff regime by testing whether the emitted prompt
    // ends with the diff they passed in — it is the one regime that inlines the input
    // verbatim. An earlier revision of this patch rebuilt the full-diff branch from the
    // surviving patches unconditionally; the reconstruction drops any preamble and
    // normalizes inter-file newlines, so the prompt stopped ending with the input and
    // the full regime became undetectable for EVERY repository, including those that
    // never set exclude_paths. A self-comparison cannot catch that, because both sides
    // of the comparison move together.
    // Trailing newline included deliberately: real `git diff` output ends with one,
    // and it is precisely what a naive reconstruction drops. Without it the synthetic
    // input round-trips through the rebuild unchanged and the assertion is vacuous.
    const diff = `${[fileDiff("src/a.ts", "one"), fileDiff("docs/b.md", "two")].join("\n")}\n`;
    expect(formatChangedFilesForPrompt(diff, 1_000_000).endsWith(diff)).toBe(true);
    expect(formatChangedFilesForPrompt(diff, 1_000_000, { excludePaths: [] }).endsWith(diff)).toBe(true);
    expect(formatChangedFilesForPrompt(diff, 1_000_000, { excludePaths: ["nothing/**"] }).endsWith(diff)).toBe(true);
  });

  it("does NOT end with the verbatim diff once a file is actually excluded", () => {
    // The complement: when an exclusion really applies, the prompt must not carry the
    // input verbatim — that is the whole point — so a consumer reading the regime
    // structurally correctly stops calling it FULL.
    const diff = [fileDiff("src/a.ts", "one"), fileDiff(".planning/b.md", "two")].join("\n");
    expect(formatChangedFilesForPrompt(diff, 1_000_000, { excludePaths: [".planning/**"] }).endsWith(diff)).toBe(false);
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

describe("slice packing (EHAC-2844: source-first, max-min fair)", () => {
  const TRUNCATED_NOTE_PREFIX = "# ... diff truncated by file for prompt budget;";

  /** A unified diff for one file whose patch is about `chars` long. */
  const sizedDiff = (path: string, chars: number, status: "modified" | "deleted" = "modified"): string => {
    const sign = status === "deleted" ? "-" : "+";
    const header =
      status === "deleted"
        ? [`diff --git a/${path} b/${path}`, "deleted file mode 100644", `--- a/${path}`, "+++ /dev/null", "@@ -1,9 +0,0 @@"]
        : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,9 @@", " context"];
    const lines = [...header];
    let length = lines.join("\n").length;
    for (let i = 0; length < chars; i++) {
      const line = `${sign}${path} line ${i} ${"x".repeat(60)}`;
      lines.push(line);
      length += line.length + 1;
    }
    return lines.join("\n");
  };

  const patchOf = (diff: string, path: string): string => {
    const file = parseUnifiedDiffFiles(diff).find((candidate) => candidate.path === path);
    if (!file) throw new Error(`no patch for ${path}`);
    return file.patch;
  };

  /** Length of the longest prefix of the file's patch that reached the prompt. */
  const shownChars = (out: string, patch: string): number => {
    let low = 0;
    let high = patch.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (out.includes(patch.slice(0, mid))) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  /**
   * The packed prompt fits the budget on its own: it is no longer than
   * maxChars and still ends with its closing note, so the final
   * slice(0, maxChars) backstop cut nothing.
   */
  const expectBackstopUnused = (out: string, maxChars: number, diff: string): void => {
    expect(out.length).toBeLessThanOrEqual(maxChars);
    const lastLine = out.slice(out.lastIndexOf("\n") + 1);
    expect(lastLine).toBe(`${TRUNCATED_NOTE_PREFIX} reviewable diff was ${diff.length.toLocaleString("en-US")} characters.`);
  };

  it("shows a large source file WHOLE when the diff is just over budget (uniform cap cut it)", () => {
    const tests = Array.from({ length: 30 }, (_, i) => sizedDiff(`test/case-${String(i).padStart(2, "0")}.test.ts`, 1_300));
    const diff = [...tests, sizedDiff("src/engine.ts", 20_000)].join("\n");
    const budget = diff.length - 3_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    expect(out).toContain("# Representative diff slices");
    expect(out.includes(patchOf(diff, "src/engine.ts"))).toBe(true);
    expectBackstopUnused(out, budget, diff);
  });

  it("serves the tests tier first for a tests-led prompt (eha_care #5129 shape)", () => {
    // Council run 40613682758: 90 files, a 350k-char diff over a ~200k budget, and
    // the Tests lens got the same source-first packing as Risk, so its own 43 test
    // files were cut to fragments. Led by the tests tier, every test file is whole
    // and source still gets the remainder.
    const sources = Array.from({ length: 40 }, (_, i) => sizedDiff(`src/mod-${String(i).padStart(2, "0")}.ts`, 6_000));
    const tests = Array.from({ length: 40 }, (_, i) => sizedDiff(`src/mod-${String(i).padStart(2, "0")}.test.ts`, 3_000));
    const diff = [...sources, ...tests].join("\n");
    const budget = 200_000;
    const testPaths = tests.map((_, i) => `src/mod-${String(i).padStart(2, "0")}.test.ts`);
    const wholeTests = (out: string) => testPaths.filter((path) => out.includes(patchOf(diff, path))).length;

    const sourceFirst = formatChangedFilesForPrompt(diff, budget);
    const testsFirst = formatChangedFilesForPrompt(diff, budget, { leadTier: "tests" });

    expect(wholeTests(sourceFirst)).toBeLessThan(testPaths.length);
    expect(wholeTests(testsFirst)).toBe(testPaths.length);
    // Source is not dropped: every source file still gets a viable slice.
    for (let i = 0; i < sources.length; i++) {
      const path = `src/mod-${String(i).padStart(2, "0")}.ts`;
      expect(shownChars(testsFirst, patchOf(diff, path))).toBeGreaterThanOrEqual(500);
    }
    expectBackstopUnused(testsFirst, budget, diff);
  });

  it("leaves the default packing byte-identical when no tier leads", () => {
    const diff = [sizedDiff("src/a.ts", 9_000), sizedDiff("src/a.test.ts", 9_000), sizedDiff("docs/a.md", 9_000)].join("\n");
    expect(formatChangedFilesForPrompt(diff, 12_000, { leadTier: undefined })).toBe(formatChangedFilesForPrompt(diff, 12_000));
  });

  it("fills tiers in order: every source file WHOLE, then tests ahead of docs", () => {
    const diff = [
      sizedDiff("docs/a.md", 10_000),
      sizedDiff("docs/b.md", 10_000),
      sizedDiff("docs/c.md", 10_000),
      sizedDiff("test/a.test.ts", 10_000),
      sizedDiff("test/b.test.ts", 10_000),
      sizedDiff("test/c.test.ts", 10_000),
      sizedDiff("src/a.ts", 10_000),
      sizedDiff("src/b.ts", 10_000),
      sizedDiff("src/c.ts", 10_000),
    ].join("\n");
    const budget = 50_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) expect(out.includes(patchOf(diff, path))).toBe(true);
    const testShown = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"].map((path) => shownChars(out, patchOf(diff, path)));
    const docsShown = ["docs/a.md", "docs/b.md", "docs/c.md"].map((path) => shownChars(out, patchOf(diff, path)));
    expect(Math.min(...testShown)).toBeGreaterThan(Math.max(...docsShown) * 3);
    expectBackstopUnused(out, budget, diff);
  });

  it("carries the slack of a file capped at MAX_FILE_SLICE_CHARS on to the next tier", () => {
    const diff = [sizedDiff("src/huge.ts", 100_000), sizedDiff("test/huge.test.ts", 50_000)].join("\n");
    const budget = 120_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    const sourceShown = shownChars(out, patchOf(diff, "src/huge.ts"));
    expect(sourceShown).toBeGreaterThan(60_000);
    expect(sourceShown).toBeLessThanOrEqual(64_000);
    expect(out.includes(patchOf(diff, "test/huge.test.ts"))).toBe(true);
    expectBackstopUnused(out, budget, diff);
  });

  it("admits the highest-priority files with viable slices and omits the lowest, never all", () => {
    const docs = Array.from({ length: 150 }, (_, i) => sizedDiff(`docs/page-${String(i).padStart(3, "0")}.md`, 2_000));
    const tests = Array.from({ length: 50 }, (_, i) => sizedDiff(`test/t-${String(i).padStart(3, "0")}.test.ts`, 2_000));
    const diff = [...docs, ...tests, sizedDiff("src/core.ts", 2_000)].join("\n");
    const budget = 40_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    expect(out.includes(patchOf(diff, "src/core.ts"))).toBe(true);
    const testPaths = tests.map((_, i) => `test/t-${String(i).padStart(3, "0")}.test.ts`);
    const shownTests = testPaths.filter((path) => out.includes(`\n# ${path} (`));
    expect(shownTests.length).toBeGreaterThan(0);
    expect(shownTests.length).toBeLessThan(testPaths.length);
    // A file that is shown at all gets a viable slice, not a sliver.
    for (const path of shownTests) expect(shownChars(out, patchOf(diff, path))).toBeGreaterThanOrEqual(500);
    expect(out).not.toContain("diff --git a/docs/page-000.md");
    expect(out).toMatch(/# \.\.\. \d+ changed file\(s\) omitted from diff slices/);
    expectBackstopUnused(out, budget, diff);
  });

  it("keeps a deleted production file in the source tier, ahead of docs, under a tight budget", () => {
    const docs = Array.from({ length: 10 }, (_, i) => sizedDiff(`docs/guide-${i}.md`, 2_000));
    const diff = [...docs, sizedDiff("src/legacy.ts", 2_000, "deleted")].join("\n");
    const budget = 9_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    expect(out).toContain("# src/legacy.ts (deleted");
    expect(out.includes(patchOf(diff, "src/legacy.ts"))).toBe(true);
    expect(promptPriority(parseUnifiedDiffFiles(diff).find((file) => file.path === "src/legacy.ts")!)).toBe(5);
    expectBackstopUnused(out, budget, diff);
  });

  it("emits blocks in priority order, deletions last, whatever order the budget was shared in", () => {
    const diff = [
      sizedDiff("src/legacy.ts", 1_500, "deleted"),
      sizedDiff("docs/notes.md", 1_500),
      sizedDiff("src/small.ts", 1_000),
      sizedDiff("src/large.ts", 70_000),
      sizedDiff("test/a.test.ts", 1_500),
    ].join("\n");

    const out = formatChangedFilesForPrompt(diff, 70_000);
    const positions = ["src/large.ts", "src/small.ts", "test/a.test.ts", "docs/notes.md", "src/legacy.ts"].map((path) =>
      out.indexOf(`\n# ${path} (`),
    );

    for (const position of positions) expect(position).toBeGreaterThan(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("shows a non-empty prefix of a single changed line longer than its slice", () => {
    const longLine = `+${"A".repeat(400_000)}`;
    const diff = [
      "diff --git a/assets/bundle.js.map b/assets/bundle.js.map",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/assets/bundle.js.map",
      "@@ -0,0 +1 @@",
      longLine,
    ].join("\n");
    const budget = 200_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    expect(out.includes(`+${"A".repeat(10_000)}`)).toBe(true);
    expect(out).toContain("# ... file diff truncated");
    expectBackstopUnused(out, budget, diff);
  });

  it("still trims an ordinary truncated slice back to a whole line", () => {
    const diff = [sizedDiff("src/a.ts", 30_000), sizedDiff("src/b.ts", 30_000)].join("\n");
    const out = formatChangedFilesForPrompt(diff, 20_000);
    const patch = patchOf(diff, "src/a.ts");
    const shown = shownChars(out, patch);

    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(patch.length);
    // The shown prefix stops exactly at a line end (the slice's own newline
    // before the truncation marker matches the patch's), never inside a line.
    expect(patch[shown - 1]).toBe("\n");
  });

  it("bounds the overview, by priority, so it never crowds out the first file's slice", () => {
    const docs = Array.from({ length: 400 }, (_, i) => sizedDiff(`docs/a-very-long-directory-name/page-${String(i).padStart(4, "0")}.md`, 300));
    const diff = [...docs, sizedDiff("src/only-source.ts", 300)].join("\n");
    // The floor every caller's budget is clamped to (MIN_DIFF_PROMPT_CHARS).
    const budget = 8_000;

    const out = formatChangedFilesForPrompt(diff, budget);

    expect(out).toContain("# Changed file overview (401 files");
    expect(out).toContain("# - src/only-source.ts (modified");
    expect(out).toMatch(/# \.\.\. and \d+ more changed file\(s\) not listed/);
    expect(out).not.toContain("page-0399.md");
    expect(out.includes(patchOf(diff, "src/only-source.ts"))).toBe(true);
    expectBackstopUnused(out, budget, diff);
  });

  it("still respects a budget below the minimum framing, through the backstop", () => {
    const diff = [sizedDiff("src/a.ts", 2_000), sizedDiff("docs/a.md", 2_000)].join("\n");
    expect(formatChangedFilesForPrompt(diff, 300).length).toBeLessThanOrEqual(300);
  });

  it("never needs the final backstop across budgets and diff shapes", () => {
    const diff = [
      sizedDiff("docs/readme-extra.md", 12_000),
      sizedDiff("src/a.ts", 30_000),
      sizedDiff("src/b.ts", 900),
      sizedDiff("src/old.ts", 4_000, "deleted"),
      sizedDiff("test/a.test.ts", 8_000),
      sizedDiff("config/app.yaml", 5_000),
      ...Array.from({ length: 40 }, (_, i) => sizedDiff(`docs/n-${i}.md`, 800)),
    ].join("\n");
    for (let budget = 8_000; budget < diff.length; budget += 3_700) {
      expectBackstopUnused(formatChangedFilesForPrompt(diff, budget), budget, diff);
    }
  });

  it("is deterministic and independent of the order files appear in the diff", () => {
    const parts = [
      sizedDiff("src/a.ts", 9_000),
      sizedDiff("src/b.ts", 9_000),
      sizedDiff("test/a.test.ts", 9_000),
      sizedDiff("docs/a.md", 9_000),
    ];
    const forward = formatChangedFilesForPrompt(parts.join("\n"), 20_000);
    const again = formatChangedFilesForPrompt(parts.join("\n"), 20_000);
    const reversed = formatChangedFilesForPrompt([...parts].reverse().join("\n"), 20_000);
    const slices = (out: string) => out.slice(out.indexOf("# Representative diff slices"));

    expect(again).toBe(forward);
    expect(slices(reversed)).toBe(slices(forward));
  });

  describe("FULL regime is unchanged", () => {
    const fileDiff = (path: string, body: string) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,2 @@", " context", `+${body}`].join("\n");
    const diff = `${[fileDiff("src/a.ts", "one"), fileDiff("docs/b.md", "two"), fileDiff("test/c.test.ts", "three")].join("\n")}\n`;
    const patchLines = (path: string, body: string) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,2 @@",
      " context",
      `+${body}`,
    ];

    it("matches the golden output recorded from the pre-change packer (c410bfe)", () => {
      const golden = [
        "# Changed file overview (3 files, +3/-0)",
        "# - src/a.ts (modified, +1/-0)",
        "# - docs/b.md (modified, +1/-0)",
        "# - test/c.test.ts (modified, +1/-0)",
        "",
        "# Full diff",
        ...patchLines("src/a.ts", "one"),
        ...patchLines("docs/b.md", "two"),
        ...patchLines("test/c.test.ts", "three"),
        "",
      ].join("\n");
      const goldenExcluded = [
        "# Changed file overview (2 files, +2/-0)",
        "# - src/a.ts (modified, +1/-0)",
        "# - test/c.test.ts (modified, +1/-0)",
        "# ... 1 changed file(s) excluded from this prompt by exclude_paths and NOT shown; do not report findings about them.",
        "",
        "# Full diff",
        ...patchLines("src/a.ts", "one"),
        ...patchLines("test/c.test.ts", "three"),
      ].join("\n");

      expect(formatChangedFilesForPrompt(diff, 320_000)).toBe(golden);
      expect(formatChangedFilesForPrompt(diff, 320_000, { excludePaths: ["docs/**"] })).toBe(goldenExcluded);
    });

    it("stays FULL at exactly the budget and switches to slices one character below it", () => {
      const full = formatChangedFilesForPrompt(diff, 320_000);
      expect(formatChangedFilesForPrompt(diff, full.length)).toBe(full);
      expect(formatChangedFilesForPrompt(diff, full.length - 1)).toContain("# Representative diff slices");
    });
  });
});
