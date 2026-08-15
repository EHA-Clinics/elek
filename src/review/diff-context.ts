export interface ChangedFilePatch {
  path: string;
  oldPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface PromptPackingOptions {
  /**
   * Repo-relative globs whose files are DROPPED from the packed prompt
   * entirely — contents, overview entry and all. Distinct from `ignore_paths`,
   * which only asks the model to suppress findings and still transmits the file.
   */
  excludePaths?: readonly string[];
  /**
   * Extra file extensions (without the dot) to treat as priority-0 production
   * source, on top of the built-in list. Opt-in and empty by default.
   *
   * The built-in list is language source only, so an infrastructure repo whose
   * real product is `.tf` — or a frontend whose product is `.vue` — has NO
   * priority-0 files at all. Everything it ships is priority 2, ordered behind
   * any language file in the diff and unable to fail a coverage check that only
   * considers priority 0. This lets such a repo opt its own source in without
   * changing the default for anyone else.
   */
  productionExtensions?: readonly string[];
}

const MIN_FILE_SLICE_CHARS = 700;
const MAX_FILE_SLICE_CHARS = 64_000;
const DEFAULT_MODEL_INPUT_BUDGET_CHARS = 320_000;
const MIN_DIFF_PROMPT_CHARS = 8_000;

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile a minimatch-style path glob to an anchored RegExp.
 *
 * Semantics deliberately mirror gitignore-style globbers rather than fnmatch
 * (whose `*` crosses `/` and would over-match):
 *   - `**​/` matches zero or more leading directory segments, so `**​/fixtures/**`
 *     also matches a repo-root `fixtures/a.py`
 *   - `**`  matches anything, including `/`
 *   - `*`   matches anything except `/` (a single path segment)
 *   - `?`   matches a single non-`/` character
 * Every other character is literal. Matching is case-sensitive, because git
 * paths are.
 *
 * LIMITATION: brace expansion (`{ts,tsx}`) and character classes (`[abc]`) are
 * NOT supported — those characters are escaped to literals, so such a glob
 * compiles to a pattern that never matches. Add handling here before allowing
 * one into `exclude_paths`, or the exclusion silently stops applying.
 *
 * Implemented in-file with ZERO dependencies on purpose: this module is
 * vendored byte-for-byte into the AI-review coverage gate and executed there
 * standalone via Node type-stripping, where npm resolution is unavailable. A
 * `minimatch` import would work here and break there.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += pattern[i].replace(REGEX_SPECIAL_CHARS, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function compileExcludePatterns(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed) compiled.push(globToRegExp(trimmed));
  }
  return compiled;
}

/** True when `path` matches any of the supplied globs. */
export function isPathExcluded(path: string, patterns: readonly string[] | undefined): boolean {
  return compileExcludePatterns(patterns).some((rx) => rx.test(path));
}

/**
 * Partition parsed diff files into those that survive `exclude_paths` and those
 * dropped by it. A renamed file is excluded only when BOTH its old and new
 * paths match, so moving a file OUT of an excluded tree still gets reviewed.
 */
export function applyExcludePaths(
  files: readonly ChangedFilePatch[],
  patterns: readonly string[] | undefined,
): { kept: ChangedFilePatch[]; excluded: ChangedFilePatch[] } {
  const compiled = compileExcludePatterns(patterns);
  if (compiled.length === 0) return { kept: [...files], excluded: [] };

  const kept: ChangedFilePatch[] = [];
  const excluded: ChangedFilePatch[] = [];
  for (const file of files) {
    const newMatches = compiled.some((rx) => rx.test(file.path));
    const oldMatches = compiled.some((rx) => rx.test(file.oldPath));
    if (newMatches && (file.status !== "renamed" || oldMatches)) {
      excluded.push(file);
    } else {
      kept.push(file);
    }
  }
  return { kept, excluded };
}

/**
 * Approximate full-input budgets after reserving model output and provider
 * framing. Code-heavy prompts average about three characters per token.
 */
export function modelInputBudgetChars(modelLabel: string): number {
  const normalized = modelLabel.toLowerCase();
  if (/kimi[-_.]?k3/.test(normalized)) return 2_700_000;
  if (/gpt[-_.]?5[.-]?6/.test(normalized)) return 700_000;
  if (/glm[-_.]?5[.-]?2/.test(normalized)) return 540_000;
  return DEFAULT_MODEL_INPUT_BUDGET_CHARS;
}

export function diffPromptBudgetChars(modelLabel: string, reservedChars = 0): number {
  return Math.max(MIN_DIFF_PROMPT_CHARS, modelInputBudgetChars(modelLabel) - Math.max(0, reservedChars));
}

export function parseUnifiedDiffFiles(diff: string): ChangedFilePatch[] {
  const starts = [...diff.matchAll(/^diff --git .+$/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) return [];

  const files: ChangedFilePatch[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? diff.length;
    const patch = diff.slice(start, end).replace(/\n+$/, "");
    const firstLine = patch.split("\n", 1)[0] ?? "";
    const { oldPath, newPath } = parseDiffHeader(firstLine);
    const status = patch.includes("\ndeleted file mode ")
      ? "deleted"
      : patch.includes("\nnew file mode ")
        ? "added"
        : patch.includes("\nrename from ") || patch.includes("\nrename to ")
          ? "renamed"
          : "modified";
    const counts = countPatchChanges(patch);
    files.push({
      path: status === "deleted" ? oldPath : newPath,
      oldPath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
    });
  }
  return files;
}

export function formatChangedFilesForPrompt(
  diff: string | undefined,
  maxChars = DEFAULT_MODEL_INPUT_BUDGET_CHARS,
  options: PromptPackingOptions = {},
): string {
  if (!diff) return "(diff unavailable; inspect files from the workspace if needed)";

  const excludePatterns = options.excludePaths ?? [];
  const parsed = parseUnifiedDiffFiles(diff);
  if (parsed.length === 0) {
    // FAIL CLOSED. With no parseable `diff --git` headers we cannot attribute
    // content to paths, so we cannot honour exclude_paths. Emitting the raw
    // diff here would transmit excluded files and quietly falsify the guarantee
    // the key exists to provide, so we withhold it instead.
    if (excludePatterns.length > 0) {
      return "(diff could not be parsed into per-file patches; withheld because exclude_paths is configured and exclusion could not be verified — inspect files from the workspace with read/grep/find/ls)";
    }
    return fallbackTruncatedDiff(diff, maxChars);
  }

  const { kept: files, excluded } = applyExcludePaths(parsed, excludePatterns);
  const excludedNote =
    excluded.length > 0
      ? `# ... ${excluded.length} changed file(s) excluded from this prompt by exclude_paths and NOT shown; do not report findings about them.`
      : "";
  if (files.length === 0) {
    return `# Changed file overview (0 reviewable files)\n${excludedNote || "# ... every changed file was excluded by exclude_paths."}`;
  }

  // Rebuild the diff from the SURVIVING patches ONLY when something was actually
  // excluded. Reusing the raw `diff` string after an exclusion would re-admit every
  // excluded file through the full-diff path below — but reconstructing it when
  // NOTHING was excluded is also wrong: the reconstruction is not byte-identical to
  // the input (it drops any preamble and normalizes inter-file newlines), so the
  // emitted prompt would stop ending with the verbatim diff. Downstream consumers
  // detect the full-diff regime structurally, by exactly that relationship, so an
  // unconditional rebuild silently makes the full regime undetectable for every
  // repository — including the ones that never set exclude_paths at all.
  const keptDiff = excluded.length === 0 ? diff : files.map((file) => file.patch).join("\n");
  const overview = [formatFileOverview(files), excludedNote].filter(Boolean).join("\n");
  const fullDiffWithOverview = `${overview}\n\n# Full diff\n${keptDiff}`;
  if (fullDiffWithOverview.length <= maxChars) {
    return fullDiffWithOverview;
  }

  const sorted = [...files].sort(comparePromptPriorityWith(options.productionExtensions));
  const remainingBudget = Math.max(0, maxChars - overview.length - 1_200);
  const perFileBudget = Math.max(
    MIN_FILE_SLICE_CHARS,
    Math.min(MAX_FILE_SLICE_CHARS, Math.floor(remainingBudget / Math.max(1, Math.min(files.length, 40)))),
  );

  const blocks: string[] = [
    overview,
    "",
    "# Representative diff slices",
    "# Slices are prioritized toward non-deleted production files so later application changes are not starved by early docs/workflow churn.",
  ];
  const included = new Set<string>();
  let omitted = 0;

  for (const file of sorted) {
    const slice = slicePatch(file.patch, perFileBudget);
    const header = `\n# ${file.path} (${file.status}, +${file.additions}/-${file.deletions})\n`;
    const block = `${header}${slice}`;
    const nextLength = blocks.join("\n").length + block.length + 240;
    if (nextLength > maxChars) {
      omitted++;
      continue;
    }
    blocks.push(block);
    included.add(file.path);
  }

  omitted = files.length - included.size;
  if (omitted > 0) {
    blocks.push("");
    blocks.push(`# ... ${omitted} changed file(s) omitted from diff slices; see the full file overview above and inspect files with read/grep/find/ls as needed.`);
  }
  blocks.push("");
  blocks.push(`# ... diff truncated by file for prompt budget; reviewable diff was ${keptDiff.length.toLocaleString("en-US")} characters.`);

  return blocks.join("\n").slice(0, maxChars);
}

function parseDiffHeader(line: string): { oldPath: string; newPath: string } {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return { oldPath: "(unknown)", newPath: "(unknown)" };
  return { oldPath: unquotePath(match[1]), newPath: unquotePath(match[2]) };
}

function unquotePath(path: string): string {
  return path.replace(/^"|"$/g, "");
}

function countPatchChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function formatFileOverview(files: ChangedFilePatch[]): string {
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = [
    `# Changed file overview (${files.length} file${files.length === 1 ? "" : "s"}, +${totalAdditions}/-${totalDeletions})`,
    ...files.map((file) => `# - ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`),
  ];
  return lines.join("\n");
}

function comparePromptPriorityWith(
  extraExtensions: readonly string[] | undefined,
): (a: ChangedFilePatch, b: ChangedFilePatch) => number {
  return (a, b) => {
    const score = promptPriority(a, extraExtensions) - promptPriority(b, extraExtensions);
    if (score !== 0) return score;
    const churn = (b.additions + b.deletions) - (a.additions + a.deletions);
    if (churn !== 0) return churn;
    return a.path.localeCompare(b.path);
  };
}

export function promptPriority(
  file: ChangedFilePatch,
  extraExtensions?: readonly string[],
): number {
  const nonCode = isDocsOrWorkflow(file.path);
  if (file.status === "deleted" && nonCode) return 6;
  if (file.status === "deleted") return 5;
  if (isProductionCode(file.path, extraExtensions)) return 0;
  if (isTestCode(file.path)) return 1;
  if (nonCode) return 4;
  return 2;
}

/** Normalize `.tf` / `tf` / `TF` to a bare lowercase extension. */
function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

function isDocsOrWorkflow(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith(".github/") ||
    lower.startsWith("docs/") ||
    lower === "readme.md" ||
    lower.startsWith("readme.") ||
    lower.startsWith("changelog.") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".rst") ||
    lower.endsWith(".adoc")
  );
}

function isProductionCode(path: string, extraExtensions?: readonly string[]): boolean {
  const lower = path.toLowerCase();
  if (isTestCode(lower) || isDocsOrWorkflow(lower)) return false;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|ex|exs|erl|hrl|sql)$/.test(lower)) {
    return true;
  }
  if (!extraExtensions || extraExtensions.length === 0) return false;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = lower.slice(dot + 1);
  return extraExtensions.some((candidate) => normalizeExtension(candidate) === ext);
}

function isTestCode(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("__tests__/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.endsWith("_test.go")
  );
}

function slicePatch(patch: string, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  const slice = patch.slice(0, Math.max(0, maxChars - 140)).replace(/\n[^\n]*$/, "");
  return `${slice}\n# ... file diff truncated; inspect this file directly if it is relevant.`;
}

function fallbackTruncatedDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, Math.max(0, maxChars - 120))}\n\n... diff truncated for prompt budget; use read/grep/find/ls tools for more context.`;
}
