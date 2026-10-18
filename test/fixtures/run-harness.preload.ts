/**
 * Preload for driving `src/entrypoints/run.ts` end to end in a CHILD process.
 *
 * The orchestrator calls `run()` at import time and owns its process, so it cannot be
 * driven inside the shared `bun test` process, and `mock.module` there would leak into
 * every other test file. A child `bun --preload <this> src/entrypoints/run.ts` gets its
 * own module registry: the model runner, the GitHub data fetch, the comment API and
 * octokit are replaced here, and everything else (inputs, plan, council policy, retry
 * decisions, summary finalizer) is the real code.
 *
 * Driven by environment:
 *   ELEK_HARNESS_SCRIPT  JSON `{ "synthesis": [<PiRunResult overrides>, ...] }`. The
 *                        nth non-lens run gets entry n; lens runs always succeed.
 *   ELEK_HARNESS_CALLS   file that receives one JSON line per model run.
 *   ELEK_HARNESS_JOB_STARTED_AT_MS  when the job started (epoch ms); unset = unmeasurable.
 */
import { mock } from "bun:test";
import { appendFileSync } from "fs";

const src = new URL("../../src/", import.meta.url).pathname;
const script = JSON.parse(process.env.ELEK_HARNESS_SCRIPT || "{}") as {
  synthesis?: Array<Record<string, unknown>>;
};
const callsPath = process.env.ELEK_HARNESS_CALLS || "";
let synthesisCalls = 0;

const realPi = await import(`${src}pi.ts`);
mock.module(`${src}pi.ts`, () => ({
  ...realPi,
  runPi: async (
    prompt: string,
    inputs: { provider: string; model: string; runTimeoutSeconds: number },
    _onProgress: unknown,
    _useMcp: boolean,
    options: { promptName?: string } = {},
  ) => {
    const promptName = options.promptName || "prompt";
    const isLens = promptName.startsWith("lens-");
    const scripted = isLens ? {} : (script.synthesis ?? [])[synthesisCalls++] ?? {};
    if (callsPath) {
      appendFileSync(
        callsPath,
        `${JSON.stringify({
          promptName,
          model: inputs.model,
          runTimeoutSeconds: inputs.runTimeoutSeconds,
          promptNamesModel: prompt.includes(inputs.model),
        })}\n`,
      );
    }
    return {
      conclusion: "success",
      output: isLens ? "No findings." : "## Review\n\nNo blocking findings.",
      turnsUsed: 3,
      providerRetries: 0,
      durationSeconds: 1,
      costUsd: 0,
      usage: { inputTokens: 10, outputTokens: 10, estimated: false, modelLabel: inputs.model, source: "provider" },
      ...scripted,
    };
  },
}));

const realData = await import(`${src}github/data.ts`);
mock.module(`${src}github/data.ts`, () => ({
  ...realData,
  fetchGitHubData: async (context: { actor: string; entityNumber: number }) => ({
    type: "pr",
    title: "harness",
    body: "",
    author: context.actor,
    comments: [],
    reviewComments: [],
    labels: [],
    assignees: [],
    entityNumber: context.entityNumber,
    pr: { headRef: "feature", baseRef: "main" },
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  }),
}));

const realComments = await import(`${src}github/comments.ts`);
mock.module(`${src}github/comments.ts`, () => ({
  ...realComments,
  createTrackingComment: async () => ({ id: 1 }),
  updateTrackingComment: async () => {},
  postComment: async () => ({ id: 2 }),
  createPRReview: async () => {},
  fetchReviewComments: async () => [],
}));

// The job clock. On a real runner it is the Runner.Worker ancestor's age (test/job-clock.test.ts
// proves that in CI); here the test sets when the job started, so a run near the cap is reachable.
const realJobClock = await import(`${src}review/job-clock.ts`);
mock.module(`${src}review/job-clock.ts`, () => ({
  ...realJobClock,
  measuredJobElapsedSeconds: () => {
    const startedAt = Number(process.env.ELEK_HARNESS_JOB_STARTED_AT_MS);
    return Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : undefined;
  },
}));

mock.module("@actions/github", () => ({
  context: {},
  getOctokit: () => ({
    rest: {
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "admin" } }) },
      pulls: { get: async () => ({ data: {} }) },
    },
  }),
}));
