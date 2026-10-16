/**
 * U4: elek records WHICH diff it reviewed — the source and the exact commits —
 * at the moment it reads the diff.
 *
 * Measured on eha_care: a branch updated mid-council left the coverage record
 * naming one head while elek had reviewed another (#4723: elek fell back to
 * GitHub's live API diff of the NEW head, silently). These tests drive the real
 * git code in a throwaway repository, in a subprocess so the test's own cwd is
 * never touched.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { fetchGitHubData } from "../src/github/data";

const dataModule = resolve(import.meta.dir, "../src/github/data.ts");

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  /** The PR head as the event / pulls.get named it. */
  prSha: string;
  /** The base tip the event payload named, before the base moved. */
  eventBaseSha: string;
  /** origin/main when the diff is read. */
  baseTipSha: string;
}

function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "elek-u4-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Elek Test");
  git("config", "user.email", "elek@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "reviewed.txt"), "base\n", "utf-8");
  git("add", "reviewed.txt");
  git("commit", "-q", "-m", "base");
  const eventBaseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "reviewed.txt"), "base\npr\n", "utf-8");
  git("add", "reviewed.txt");
  git("commit", "-q", "-m", "pr");
  const prSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "other.txt"), "base moved\n", "utf-8");
  git("add", "other.txt");
  git("commit", "-q", "-m", "base moves after the event");
  const baseTipSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", baseTipSha);
  git("update-ref", "refs/remotes/origin/feature", prSha);
  git("remote", "add", "origin", "https://invalid.invalid/repo.git");
  return { dir, git, prSha, eventBaseSha, baseTipSha };
}

/** Run fetchGitHubData in `dir` and return what it recorded. */
function fetchIn(
  dir: string,
  pr: { headRef: string; baseRef: string; headSha: string; baseSha: string },
  apiDiff?: string,
): { diff: string; diffProvenance?: Record<string, string> } {
  const context = {
    eventName: "issue_comment",
    eventAction: "created",
    actor: "alice",
    repo: { owner: "acme", repo: "app", fullName: "acme/app", defaultBranch: "main" },
    entityNumber: 17,
    isPR: true,
    triggerText: "@elek review",
    pr: { title: "t", body: "", ...pr },
  };
  const script = [
    `import { fetchGitHubData } from ${JSON.stringify(dataModule)};`,
    `const apiDiff = ${JSON.stringify(apiDiff ?? null)};`,
    "const octokit = apiDiff === null ? undefined : {",
    "  rest: {",
    "    issues: { listComments: async () => ({ data: [] }) },",
    "    pulls: { get: async () => ({ data: apiDiff }) },",
    "  },",
    "};",
    `const data = await fetchGitHubData(${JSON.stringify(context)}, octokit);`,
    "process.stdout.write(JSON.stringify({ diff: data.diff, diffProvenance: data.diffProvenance }));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

describe("reviewed diff provenance (U4)", () => {
  it("records the local remote-ref diff with the commits it was built from", () => {
    const repo = makeRepo();
    try {
      const data = fetchIn(repo.dir, {
        headRef: "feature",
        baseRef: "main",
        headSha: repo.prSha,
        baseSha: repo.eventBaseSha,
      });

      expect(data.diffProvenance).toEqual({
        diffSource: "remote",
        reviewedHeadSha: repo.prSha,
        // The base tip the diff was computed against, NOT the event payload's base.
        reviewedBaseSha: repo.baseTipSha,
      });
      expect(repo.baseTipSha).not.toBe(repo.eventBaseSha);
      // Diffing the resolved SHAs prints exactly what the ref range printed.
      expect(data.diff).toBe(
        execFileSync("git", ["diff", "origin/main...origin/feature"], {
          cwd: repo.dir,
          encoding: "utf-8",
        }),
      );
      expect(data.diff).toContain("+pr");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("records the checked-out HEAD it diffed, not the event's PR head", () => {
    // A pull_request checkout is a merge commit that CONTAINS the PR head. The
    // tree elek diffed is the merge commit's, so that is the head it records.
    const repo = makeRepo();
    try {
      repo.git("checkout", "-q", "-b", "pr-merge", repo.baseTipSha);
      repo.git("merge", "-q", "--no-ff", "-m", "merge", repo.prSha);
      const mergeSha = repo.git("rev-parse", "HEAD");

      const data = fetchIn(repo.dir, {
        headRef: "feature",
        baseRef: "main",
        headSha: repo.prSha,
        baseSha: repo.eventBaseSha,
      });

      expect(data.diffProvenance).toEqual({
        diffSource: "head",
        reviewedHeadSha: mergeSha,
        reviewedBaseSha: repo.baseTipSha,
      });
      expect(mergeSha).not.toBe(repo.prSha);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("marks GitHub's API diff as api and names NO commit (the #4723 shape)", () => {
    // The PR moved after the checkout: elek's PR head is not in the local refs,
    // so it falls back to GitHub's live diff. The PR head SHA is known to the job
    // but is not proof of what GitHub diffed, so no SHA may be recorded.
    const repo = makeRepo();
    try {
      const movedHead = "f".repeat(40);
      const data = fetchIn(
        repo.dir,
        { headRef: "feature", baseRef: "main", headSha: movedHead, baseSha: repo.eventBaseSha },
        "diff --git a/a.ts b/a.ts\n+from the api\n",
      );

      expect(data.diff).toContain("+from the api");
      expect(data.diffProvenance).toEqual({ diffSource: "api" });
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("marks an empty local diff that falls back to the API as api", () => {
    // Today an empty local diff also falls back to the API. That path must not
    // keep the local SHAs it computed for the empty diff.
    const repo = makeRepo();
    try {
      const data = fetchIn(
        repo.dir,
        { headRef: "main", baseRef: "main", headSha: repo.baseTipSha, baseSha: repo.eventBaseSha },
        "diff --git a/b.ts b/b.ts\n+api\n",
      );

      expect(data.diffProvenance).toEqual({ diffSource: "api" });
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("run.ts hands the provenance to the summary as soon as the diff is read", () => {
    // run() executes on import, so its wiring is asserted on the source, as the
    // retry-layering tests do: one diff read, and the provenance reaches the
    // finalizer before any model runs, so every later terminal path carries it.
    const runSource = readFileSync(resolve(import.meta.dir, "../src/entrypoints/run.ts"), "utf-8");
    const reads = [...runSource.matchAll(/\bfetchGitHubData\s*\(/g)];
    expect(reads).toHaveLength(1);
    const wiring = runSource.indexOf("finalizer.update({ diffProvenance: data.diffProvenance })");
    expect(wiring).toBeGreaterThan(reads[0].index!);
    expect(wiring).toBeLessThan(runSource.search(/\brunPi\s*\(/));
  });

  it("records nothing for an issue (no diff was read)", async () => {
    const data = await fetchGitHubData({
      eventName: "issues",
      eventAction: "opened",
      actor: "alice",
      repo: { owner: "acme", repo: "app", fullName: "acme/app", defaultBranch: "main" },
      entityNumber: 3,
      isPR: false,
      triggerText: "@elek",
      issue: { title: "i", body: "", labels: [], assignees: [] },
    });
    expect(data.diffProvenance).toBeUndefined();
  });
});
