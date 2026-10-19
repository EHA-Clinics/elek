#!/usr/bin/env node
/**
 * elek — Model-agnostic AI code review for GitHub.
 * Sift through PRs and issues with pi coding agent.
 *
 * Orchestrates:
 *  1. Parse GitHub event context
 *  2. Detect trigger conditions (@pi mentions, explicit prompts)
 *  3. Fetch GitHub data (PR diff, issue body)
 *  4. Run pi with the built prompt
 *  5. Post results back to GitHub (comments, reviews)
 *  6. Handle git branches for code changes
 *
 * No MCP servers, no bun, no vendor lock-in. Just pi and a few modules.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

import { parseInputs, parseEntityContext } from "../github/context.js";
import { assessSerialBudget, reportSerialBudget } from "../review/serial-budget.js";
import {
  applyConfigDefaults,
  formatConfigAuditLog,
  loadBaseBranchElekConfig,
  loadElekConfig,
  loadRepoKnowledge,
  mergeBasePolicyWithWorkspaceGuidance,
} from "../config.js";
import { detectTrigger, isActorAuthorized } from "../github/trigger.js";
import { fetchGitHubData, buildPrompt } from "../github/data.js";
import { resolveEffectivePiTools, resolveMode } from "../github/mode.js";
import { postBuffered } from "./post-buffered.js";
import {
  configureGitAuth,
  createElekBranch,
  commitChanges,
  pushBranch,
} from "../github/git.js";
import {
  createTrackingComment,
  updateTrackingComment,
  createPRReview,
  postComment,
  fetchReviewComments,
} from "../github/comments.js";
import { runPi } from "../pi.js";
import { reasoningBudgets, validateReasoningSchedule } from "../openrouter-reasoning.js";
import type { ProgressEvent } from "../pi.js";
import { formatProgressComment, type ProgressState } from "../github/progress.js";
import { publicReviewCoverage } from "../review/public-coverage.js";
import { spinnerHeader } from "../github/spinner.js";
import type { PiRunResult } from "../types.js";
import {
  buildLensPrompt,
  buildSynthesisPrompt,
  resolveReviewPlan,
  costEstimateLensJobs,
  costEstimateSynthesisModels,
  resolveReviewPlanSupport,
  resolveValidatorFailoverModel,
  resolveValidatorReviewFailoverModel,
  selectReviewPlanWithinBudget,
  type DiffPromptBudgetReport,
  type ModelSpec,
  type ReviewJob,
  type ReviewPlan,
} from "../review/strategy.js";
import {
  aggregateCosts,
  costFromPiResult,
  formatCostLine,
  estimatePromptOnlyCost,
  modelLabelFor,
  type ReviewCost,
} from "../review/cost.js";
import {
  metricFromPiRun,
  type ReviewAttemptMetric,
  type ReviewRunMetric,
} from "../review/summary.js";
import { executeLensWithRetry, type LensAttemptOverrides } from "../review/lens-execution.js";
import { executeSynthesisWithFailover, type SynthesisAttemptOverrides } from "../review/synthesis-execution.js";
import { measuredJobElapsedSeconds } from "../review/job-clock.js";
import { resolveRoleTimeouts } from "../review/role-timeouts.js";
import {
  evaluateCouncilPolicy,
  type CouncilPolicyResult,
} from "../review/council-policy.js";
import { createSummaryFinalizer, type SummaryFinalizer } from "../review/summary-finalizer.js";
import { findingsCountOf, parseReviewFindings } from "../review/findings.js";
import { preparePublicReviewOutput } from "../review/public-output.js";
import { configuredPublicModelLabel, modelLabelRedactionTerms, publicModelLabelFor } from "../review/public-label.js";
import { inlineReviewBufferFromFindings } from "../review/inline-fallback.js";
import { sanitize } from "../mcp/handlers.js";
import type { PostSummary } from "./post-buffered.js";
import type { ActionInputs } from "../types.js";

/**
 * The live finalizer, visible to the top-level failure handler.
 *
 * Module scope is deliberate and is the whole point: an exception thrown ANYWHERE
 * after the context is parsed must still be able to emit a failure summary. The
 * previous code lost every terminal record precisely because the only emit site
 * was the last statement of the happy path.
 */
let activeFinalizer: SummaryFinalizer | undefined;

async function run(): Promise<void> {
  // ── Phase 0: Parse inputs & context ──────────────────────────────────
  core.setOutput("cost_usd", "0.000000");
  core.setOutput("input_tokens", "0");
  core.setOutput("output_tokens", "0");
  core.setOutput("review_summary_path", "");
  core.setOutput("review_summary_json", "");

  const actionStartedAt = new Date();
  // Context BEFORE inputs, deliberately. Input validation can fail closed (see
  // parseStallTimeoutSecondsInput), and a configuration failure that happens
  // before the context exists cannot emit a summary at all. Parsing the event
  // first means a bad input is reported as a failure summary rather than as
  // silence.
  const context = parseEntityContext();

  if (!context) {
    // No context means no entity, and inventing one would be a false claim about
    // what was reviewed. This is the one supported terminal path with no summary.
    core.setFailed(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}`);
    return;
  }

  const summaryTmpDir = process.env.RUNNER_TEMP || "/tmp";
  const finalizer = createSummaryFinalizer({
    tmpDir: summaryTmpDir,
    context,
    runId: process.env.GITHUB_RUN_ID || "?",
    jobRunLink: `https://github.com/${context.repo.fullName}/actions/runs/${process.env.GITHUB_RUN_ID || "?"}`,
    startedAt: actionStartedAt,
  });
  activeFinalizer = finalizer;

  // A strict-parser throw is a CONFIGURATION error, not an unexpected one: it is
  // the caller's input being unreadable, and it has a remedy in the message. The
  // top-level catch can only say `unexpected_error`, which mislabels a typo in
  // `validator_run_timeout_seconds` as an elek bug. Parse inside the guarded
  // region and finalize with the honest terminal reason. (EHAC-2841)
  let parsedInputs: ActionInputs;
  try {
    parsedInputs = parseInputs();
  } catch (err) {
    const failureMessage = err instanceof Error ? err.message : String(err);
    console.error("Configuration error:", failureMessage);
    core.setFailed(failureMessage);
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "configuration_error",
      failureMessage,
    });
    return;
  }

  // EHAC-2280 (AC #4): assert the SERIAL wall-clock budget before any GitHub fetch
  // and before any model run. The validator runs AFTER the reviewer lenses, so the
  // worst case is `setup + 2 * run_timeout_seconds`; if that exceeds the job's own
  // cap the runner cancels the job mid-flight and the coverage record is lost
  // entirely — a red check with no findings and nothing to action.
  //
  // Failing fast here still emits a coverage record with a legible reason, which is
  // the whole point: an honest configuration error beats a guillotine 30 minutes in.
  const budget = assessSerialBudget({
    runTimeoutSeconds: parsedInputs.runTimeoutSeconds,
    validatorRunTimeoutSeconds: parsedInputs.validatorRunTimeoutSeconds,
    // The pinned invalid_output failover is a second validator-review attempt the
    // guard must count (EHAC-2522).
    validatorReviewFailoverConfigured: parsedInputs.validatorReviewFailoverModel !== undefined,
    jobTimeoutMinutes: parsedInputs.jobTimeoutMinutes,
  });
  if (reportSerialBudget(budget, core) === "abort") {
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "configuration_error",
      failureMessage: budget.message,
    });
    return;
  }

  finalizer.update({
    mode: parsedInputs.mode,
    requestedStrategy: parsedInputs.reviewStrategy,
  });

  console.log(
    `Event: ${context.eventName}.${context.eventAction} | ` +
      `${context.isPR ? "PR" : "Issue"} #${context.entityNumber} by @${context.actor}`,
  );

  // ── Phase 1: Trigger detection ───────────────────────────────────────
  const userRequest = detectTrigger(context, parsedInputs);

  if (!userRequest) {
    console.log("No trigger detected — exiting cleanly");
    core.setOutput("conclusion", "skipped");
    core.setOutput("summary", "No trigger detected");
    // A zero-run summary is emitted here so the decline is DECLARED rather than
    // inferred from an empty output. The downstream gate still validates the
    // reason against its own closed allowlist — this record is evidence, not
    // permission.
    finalizer.finalize({
      conclusion: "success",
      terminalReason: "declined",
      skipReason: "no_trigger_detected",
    });
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    core.setFailed("GITHUB_TOKEN not available");
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "configuration_error",
      failureMessage: "GITHUB_TOKEN not available",
    });
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const actorAllowed = await isActorAuthorized(
    context,
    parsedInputs,
    async ({ owner, repo, actor }) => {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: actor,
      });
      return data.permission;
    },
  );

  if (!actorAllowed) {
    console.log(
      `Actor @${context.actor} not allowed ` +
        `(webhook association: ${context.actorAssociation || "unknown"}) — exiting`,
    );
    core.setOutput("conclusion", "skipped");
    core.setOutput("summary", `Actor @${context.actor} not authorized`);
    finalizer.finalize({
      conclusion: "success",
      terminalReason: "declined",
      skipReason: "actor_not_authorized",
    });
    return;
  }

  let configBaseRef = context.pr?.baseRef || context.repo.defaultBranch;
  let canLoadBasePolicy = !context.isPR || Boolean(context.pr?.baseRef);
  if (context.isPR && !context.pr?.baseRef) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.entityNumber,
      });
      configBaseRef = pr.base?.ref || configBaseRef;
      canLoadBasePolicy = Boolean(pr.base?.ref);
      if (context.pr) {
        context.pr = {
          title: pr.title || context.pr.title,
          body: pr.body || context.pr.body,
          headRef: pr.head?.ref || context.pr.headRef,
          baseRef: pr.base?.ref || context.pr.baseRef,
          headSha: pr.head?.sha || context.pr.headSha,
          baseSha: pr.base?.sha || context.pr.baseSha,
        };
      }
    } catch (err) {
      canLoadBasePolicy = false;
      console.warn(`[config] Could not resolve PR base ref; skipping base branch policy: ${(err as Error).message}`);
    }
  }

  const workspaceConfig = loadElekConfig(parsedInputs.configPath, (message) => {
    console.warn(`[config] ${message}`);
  });
  const baseConfig = context.isPR
    ? canLoadBasePolicy
      ? loadBaseBranchElekConfig(
        parsedInputs.configPath,
        configBaseRef,
        (message) => console.warn(`[config] ${message}`),
      )
      : { config: { ignorePaths: [], excludePaths: [], prioritySourceExtensions: [], instructions: [] }, loaded: false }
    : undefined;
  const repoConfig = baseConfig
    ? mergeBasePolicyWithWorkspaceGuidance(baseConfig.config, workspaceConfig)
    : workspaceConfig;
  const repoConfigWithKnowledge = loadRepoKnowledge(repoConfig, (message) => {
    console.warn(`[config] ${message}`);
  });
  const inputs = applyConfigDefaults(parsedInputs, repoConfigWithKnowledge);
  const effectiveRepoConfig = {
    ...repoConfigWithKnowledge,
    severityThreshold: inputs.severityThreshold || repoConfigWithKnowledge.severityThreshold,
  };
  console.log(formatConfigAuditLog(
    parsedInputs.configPath,
    effectiveRepoConfig,
    inputs,
    context.isPR
      ? baseConfig?.loaded
        ? "base-branch-policy+checked-out-guidance"
        : "checked-out-guidance-only"
      : undefined,
  ));

  console.log(
    `Triggered: "${userRequest.substring(0, 120)}${userRequest.length > 120 ? "..." : ""}"`,
  );

  // ── Phase 2: Setup ───────────────────────────────────────────────────
  const modelLabel = modelLabelFor(inputs);
  // The public label names the model that WRITES the public output. In council mode that is
  // the validator, which is not known until the review plan resolves below, so this is
  // re-derived from `trackingModelLabel` at both points where that changes. Deriving it once
  // from the primary `model` input labelled every council synthesis as the Tests lens's model.
  let publicModelLabel = publicModelLabelFor(modelLabel);
  const runId = process.env.GITHUB_RUN_ID || "?";
  const jobRunLink = `https://github.com/${context.repo.fullName}/actions/runs/${runId}`;

  // Resolve mode → tool allowlist + MCP wiring
  const resolvedMode = resolveMode(inputs.mode);
  // MCP is on by default for review/review+edit modes (off only for `agent`
  // legacy mode). The earlier CI hang was caused by pi keeping stdin open;
  // fixed via stdio:["ignore",…] in pi.ts. ELEK_DISABLE_MCP=1 escape hatch
  // remains for emergency rollback.
  const mcpEnabled = resolvedMode.useMcpServer && process.env.ELEK_DISABLE_MCP !== "1";
  const piTools = resolveEffectivePiTools(resolvedMode, inputs.tools, { mcpEnabled });
  console.log(
    `Mode: ${resolvedMode.mode} | tools: ${piTools} | mcp: ${mcpEnabled}`,
  );
  if (resolvedMode.mode === "review+edit" && !resolvedMode.allowEdit) {
    console.warn("mode=review+edit is currently review-only until sandboxed file tools are available.");
  }
  if (resolvedMode.allowEdit) {
    configureGitAuth(githubToken, context);
  }
  const piInputs = { ...inputs, tools: piTools };
  // The per-role wall clocks. Unset validator input → both validator roles inherit
  // the reviewer budget, byte-identical to the behaviour before the input existed.
  // Resolved ONCE here so the budget guard, the validator-review lens (and its
  // failover replacement) and the final synthesis all read the same number.
  // (EHAC-2833; resolver extracted for testability in EHAC-2841.)
  const roleTimeouts = resolveRoleTimeouts({
    runTimeoutSeconds: inputs.runTimeoutSeconds,
    validatorRunTimeoutSeconds: inputs.validatorRunTimeoutSeconds,
  });
  if (inputs.validatorRunTimeoutSeconds !== undefined) {
    console.log(
      `[config] validator_run_timeout_seconds=${roleTimeouts.validatorReview}s ` +
        `(reviewer run_timeout_seconds=${inputs.runTimeoutSeconds}s)`,
    );
  }

  let reviewPlan = resolveReviewPlan(inputs);
  let reviewPlanSupport = resolveReviewPlanSupport(reviewPlan.strategy, {
    isPR: context.isPR,
    mode: resolvedMode.mode,
  });
  if (reviewPlanSupport.warning) console.warn(reviewPlanSupport.warning);

  // The caller-pinned final-validator failover (EHAC-3622), checked against the EFFECTIVE
  // validator (`.elek.yml` can supply it) before any model runs. A failover onto the
  // validator's own identity is a configuration error, not a retry.
  let validatorFailoverModel: ModelSpec | undefined;
  try {
    validatorFailoverModel = resolveValidatorFailoverModel(inputs, reviewPlan.validator);
  } catch (err) {
    const failureMessage = err instanceof Error ? err.message : String(err);
    console.error("Configuration error:", failureMessage);
    core.setFailed(failureMessage);
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "configuration_error",
      failureMessage,
    });
    return;
  }
  if (validatorFailoverModel) {
    console.log(
      `[config] validator_failover_model=${validatorFailoverModel.label} ` +
        "(a final synthesis ending stall, invalid_output or max_turns fails over once, within the live job clock)",
    );
  }

  let trackingModelLabel = reviewPlanSupport.enabled ? reviewPlan.validator.label : modelLabel;
  publicModelLabel = publicModelLabelFor(trackingModelLabel);

  // Determine base branch
  const baseBranch =
    inputs.baseBranch || context.pr?.baseRef || context.repo.defaultBranch;

  // Create an elek work branch for code changes (PRs only)
  let workBranch: string | undefined;
  if (context.isPR && resolvedMode.allowEdit) {
    workBranch = createElekBranch(context, inputs.branchPrefix);
  }

  // Defer sticky-comment creation until after strategy size/cost selection so
  // the hidden lane signature matches the final posting model from the start.
  let commentId = parseExistingTrackingCommentId(process.env.ELEK_TRACKING_COMMENT_ID);

  // ── Phase 3: Fetch data & build prompt ───────────────────────────────
  const data = await fetchGitHubData(context, octokit);
  // U4: record WHICH diff is under review the moment it is read, so every terminal
  // path after this point (including a failed council) names the reviewed commits.
  finalizer.update({ diffProvenance: data.diffProvenance });
  if (data.diffProvenance) {
    const p = data.diffProvenance;
    console.log(
      `[diff] diff_source=${p.diffSource} reviewed_head_sha=${p.reviewedHeadSha ?? "(none)"} ` +
        `reviewed_base_sha=${p.reviewedBaseSha ?? "(none)"}`,
    );
  }

  // Include PR review comments for context
  if (context.isPR) {
    try {
      data.reviewComments = await fetchReviewComments(octokit, context);
    } catch (err) {
      console.warn("Could not fetch review comments:", err);
    }
  }

  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  mkdirSync(promptDir, { recursive: true });
  const bufferPath = join(tmpDir, "elek-inline-buffer.jsonl");
  let prompt = "";

  // pi-mcp-adapter reads either ./.mcp.json or ~/.config/mcp/mcp.json. The
  // config must not contain secret values because review modes intentionally
  // expose read/search tools. GITHUB_TOKEN is inherited by the MCP child from
  // pi's environment; this file only contains non-secret routing metadata.
  const mcpConfigPath = mcpEnabled && context.isPR
    ? join(homedir(), ".config", "mcp", "mcp.json")
    : null;

  const writeMcpConfig = () => {
    if (!mcpConfigPath) return;
    const actionPath = process.env.GITHUB_ACTION_PATH || process.cwd();
    const serverPath = join(actionPath, "src/mcp/github-review-server.ts");
    mkdirSync(join(homedir(), ".config", "mcp"), { recursive: true });
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            "elek-review": {
              command: "tsx",
              args: [serverPath],
              env: {
                REPO_OWNER: context.repo.owner,
                REPO_NAME: context.repo.repo,
                PR_NUMBER: String(context.entityNumber),
                ELEK_TRACKING_COMMENT_ID: commentId ? String(commentId) : "",
                ELEK_BUFFER_PATH: bufferPath,
              },
              lifecycle: "eager",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`Wrote ${mcpConfigPath} for pi-mcp-adapter`);
  };

  // ── Phase 4: Run pi with progressive updates ─────────────────────────
  console.log("── Running pi ──");

  const progress: ProgressState = {
    readContext: false,
    analyzed: false,
    wroteReview: false,
    lastTool: "",
  };

  // State machine driven by what pi actually emits:
  //   1st tool_start            → "Read context" ✓
  //   2nd+ tool_start            → "Analyzed code" ✓ (still working)
  //   text_delta after tools     → still in "Writing review…" — don't tick the box
  //   "done" (run finished)      → "Review complete" ✓
  let toolsSeen = 0;
  let textStreamed = false;
  let activeModelLabel = trackingModelLabel;

  let lastUpdate = 0;
  let lastBody = "";
  const onProgress = async (event: ProgressEvent) => {
    if (event.type === "tool_start") {
      toolsSeen++;
      if (toolsSeen === 1) progress.readContext = true;
      if (toolsSeen >= 2) progress.analyzed = true;
      if (event.detail) progress.lastTool = event.detail;
    } else if (event.type === "text") {
      // Model is generating the answer → context+analysis are implicitly done
      progress.readContext = true;
      progress.analyzed = true;
      textStreamed = true;
    } else if (event.type === "done") {
      progress.readContext = true;
      progress.analyzed = true;
      progress.wroteReview = textStreamed;
    }

    if (!commentId) return;

    // Rate-limit to avoid GitHub API abuse, but always flush the "done" event.
    const now = Date.now();
    const isFinal = event.type === "done";
    if (!isFinal && now - lastUpdate < 3000) return;

    const body = formatProgressComment(progress, activeModelLabel, jobRunLink);
    if (body === lastBody && !isFinal) return; // no visible change → skip the API call
    lastUpdate = now;
    lastBody = body;
    try {
      await updateTrackingComment(octokit, context, commentId, body, trackingModelLabel);
    } catch (err) {
      console.warn("progress update failed:", (err as Error).message);
    }
  };

  const lensPromptCache = new Map<string, string>();
  // Ground truth for how much diff each prompt was actually given, reported by
  // the packer rather than re-derived by any consumer. Keyed so a cached prompt
  // does not double-report.
  const promptBudgetByKey = new Map<string, DiffPromptBudgetReport>();
  const lensPromptKey = (job: ReviewJob): string => `${job.lens.id}\0${job.model.label}`;
  const lensPromptFor = (job: ReviewJob): string => {
    const key = lensPromptKey(job);
    const cached = lensPromptCache.get(key);
    if (cached !== undefined) return cached;
    const lensPrompt = buildLensPrompt({
      data,
      userRequest,
      lens: job.lens,
      modelLabel: job.model.label,
      repoConfig: effectiveRepoConfig,
      includeDiscussion: false,
      onBudget: (report) => promptBudgetByKey.set(key, { ...report, lensId: job.lens.id }),
    });
    lensPromptCache.set(key, lensPrompt);
    return lensPrompt;
  };

  // The caller-pinned validator-review failover for invalid_output (EHAC-2522)
  // and max_turns (EHAC-3644) ONLY. Undefined unless the caller set it; never the roster.
  const validatorReviewFailoverModel = resolveValidatorReviewFailoverModel(inputs);
  // Whether a final-validator failover could ever be budgeted on this runner: the same two
  // preconditions resolveSynthesisRetrySeconds enforces at run time (a job cap, and a
  // measurable job clock). The cost estimate reserves the failover only when both hold.
  const failoverBudgetProvable =
    validatorFailoverModel !== undefined &&
    parsedInputs.jobTimeoutMinutes !== undefined &&
    measuredJobElapsedSeconds() !== undefined;

  const estimatePlannedInputCost = (plan: ReviewPlan): ReviewCost[] => {
    // Defensive only: the budget selector stops before estimating solo plans.
    if (plan.strategy === "solo") return [];

    const reviewerJobs = plan.validatorReview ? [...plan.jobs, plan.validatorReview] : plan.jobs;
    // Prices ONE extra reviewer attempt (the most expensive next-distinct-model
    // replacement, ruling 4) and the pinned validator-review failover attempt, each
    // at its own model's rates on its own prompt, so max_cost_usd cannot be
    // exceeded by an attempt it never saw.
    const priceLensJob = (job: ReviewJob) => estimatePromptOnlyCost({
      modelLabel: job.model.label,
      prompt: lensPromptFor(job),
      costRates: inputs.costRates,
    });
    const lensCosts = costEstimateLensJobs(plan, validatorReviewFailoverModel, (job) => priceLensJob(job).costUsd).map(priceLensJob);
    // The synthesis, plus the pinned final-validator failover when one is set (EHAC-3622),
    // each at its own model's rates on its own prompt.
    const synthesisCosts = costEstimateSynthesisModels(plan.validator, validatorFailoverModel, failoverBudgetProvable).map((model) =>
      estimatePromptOnlyCost({
        modelLabel: model.label,
        prompt: buildSynthesisPrompt({
          data,
          userRequest,
          modelLabel: model.label,
          jobRunLink,
          commentId,
          reports: reviewerJobs.map((job) => ({
            lens: job.lens,
            modelLabel: job.model.label,
            output: "(candidate report pending)",
            conclusion: "success",
          })),
          repoConfig: effectiveRepoConfig,
        }),
        costRates: inputs.costRates,
      }),
    );
    return [...lensCosts, ...synthesisCosts];
  };

  if (reviewPlanSupport.enabled && inputs.maxCostUsd !== undefined) {
    const budgetedPlan = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: reviewPlan,
      supportContext: { isPR: context.isPR, mode: resolvedMode.mode },
      estimateCosts: estimatePlannedInputCost,
    });
    reviewPlan = budgetedPlan.plan;
    reviewPlanSupport = budgetedPlan.support;
    for (const event of budgetedPlan.events) {
      if (event.level === "warn") {
        console.warn(event.message);
      } else {
        console.log(event.message);
      }
    }
  }

  const useReviewPlan = reviewPlanSupport.enabled;
  const scheduledThinking = useReviewPlan ? [
    inputs.thinking,
    ...(reviewPlan.validatorReview ? [inputs.advisorThinking || inputs.validatorThinking || inputs.thinking] : []),
    inputs.validatorThinking || inputs.thinking,
  ] : [inputs.thinking];
  validateReasoningSchedule(inputs.reasoningMaxTokens, scheduledThinking);
  // A per-model budget in the mode map is a budget too: the same "no cap beside off thinking"
  // rule applies to it, and it must fail here, before any model runs, not inside the extension.
  for (const budget of reasoningBudgets(inputs.openRouterReasoningModes ?? {})) {
    validateReasoningSchedule(budget, scheduledThinking, "openrouter_model_reasoning_modes");
  }
  trackingModelLabel = useReviewPlan ? reviewPlan.validator.label : modelLabel;
  activeModelLabel = trackingModelLabel;
  publicModelLabel = publicModelLabelFor(trackingModelLabel);
  console.log(`[config] execution_strategy=${useReviewPlan ? reviewPlan.strategy : "solo"}`);

  if (inputs.stickyComment) {
    if (commentId) {
      console.log(`Using existing elek tracking comment #${commentId}`);
    } else {
      try {
        const comment = await createTrackingComment(octokit, context, trackingModelLabel);
        commentId = comment.id;
      } catch (err) {
        console.warn("Could not create tracking comment:", err);
      }
    }
  }

  prompt = buildPrompt(data, userRequest, modelLabel, jobRunLink, commentId, {
    useMcp: mcpEnabled,
    allowEdit: resolvedMode.allowEdit,
    tools: piTools,
    repoConfig: effectiveRepoConfig,
    publicModelLabel,
  });
  writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");

  const runCosts: ReviewCost[] = [];
  const runMetrics: ReviewRunMetric[] = [];
  // Every PHYSICAL attempt, including the discarded one when a retry succeeded.
  // `runMetrics` stays one DECISIVE entry per logical lens so quorum arithmetic
  // downstream remains 1:1 with the council; the two views answer different
  // questions and conflating them is how a retry became invisible.
  const attemptMetrics: ReviewAttemptMetric[] = [];
  let retriedLensIdsForSummary: string[] = [];
  let councilPolicy: CouncilPolicyResult | undefined;

  let finalInputs = piInputs;
  // Builds the synthesis prompt for the final-validator failover on the SAME lens reports
  // (EHAC-3622). Set only for a review plan: solo has no synthesis to fail over.
  let failoverPromptFor: ((model: ModelSpec) => string) | undefined;
  if (useReviewPlan) {
    const lensTools = resolveMode("review").piTools
      .split(",")
      .filter((tool) => tool !== "mcp")
      .join(",");

    console.log(
      `Review strategy: ${reviewPlan.strategy} | lenses: ${reviewPlan.jobs
        .map((j) => `${j.lens.id}:${j.model.label}`)
        .join(", ")} | advisor: ${reviewPlan.validatorReview?.model.label || "(off)"} | orchestrator: ${reviewPlan.validator.label}`,
    );
    if (reviewPlan.reusedModels) {
      console.warn(
        `Review strategy has ${reviewPlan.jobs.length} lenses but fewer reviewer models; models will be reused across lenses.`,
      );
    }

    if (commentId) {
      try {
        await updateTrackingComment(
          octokit,
          context,
          commentId,
          [
            spinnerHeader(modelLabel, `running ${reviewPlan.strategy} review`),
            "",
            ...reviewPlan.jobs.map((j) => `- ${j.lens.title}`),
            reviewPlan.validatorReview
              ? `- ${reviewPlan.validatorReview.lens.title}`
              : "",
            "",
            `Orchestrator validation and posting`,
            `[View run](${jobRunLink})`,
          ].join("\n"),
          trackingModelLabel,
        );
      } catch (err) {
        console.warn("Could not update strategy status:", err);
      }
    }

    const reviewerJobs = reviewPlan.validatorReview ? [...reviewPlan.jobs, reviewPlan.validatorReview] : reviewPlan.jobs;
    // The reviewer roster failover draws from. The advisor's model is deliberately
    // NOT in it: the advisor is an independent audit, and swapping a stalled
    // reviewer onto it would collapse two nominally independent opinions into one.
    const reviewerRoster: ModelSpec[] = reviewPlan.jobs.map((j) => j.model);

    const lensInputsFor = (job: ReviewJob, overrides?: LensAttemptOverrides) => ({
      ...piInputs,
      provider: job.model.provider,
      model: job.model.model,
      thinking: job.role === "validator-review"
        ? inputs.advisorThinking || inputs.validatorThinking || inputs.thinking
        : inputs.thinking,
      // The validator-review audit lens is a VALIDATOR role, not a reviewer: it
      // carries the validator budget (EHAC-2833), not the reviewer's. Because
      // the failover replacement preserves `role` (lens-execution), a 404
      // failover resolves the SAME budget through the same role branch.
      // A `timeout` retry (ruling 4) runs on the shorter budget the executor hands
      // over; every other attempt keeps its role's budget.
      runTimeoutSeconds:
        overrides?.runTimeoutSeconds ??
        (job.role === "validator-review" ? roleTimeouts.validatorReview : roleTimeouts.reviewer),
      tools: lensTools,
      mode: "review",
    });

    const lensRuns = await Promise.all(
      reviewerJobs.map(async (job) => {
        // A required lens failure fails the whole review unless the council still
        // reaches quorum. Exactly ONE elek-managed outer retry is permitted, and
        // WHAT that retry changes now depends on the terminal failure class:
        //
        //   stall / max_turns / invalid_output -> next distinct model
        //   timeout                            -> next distinct model, on a SHORTER
        //                                         budget (resolveTimeoutRetrySeconds)
        //   provider_transient                 -> same model
        //   everything else                    -> no retry, fail closed
        //
        // The validator-review lane is narrower: provider_unavailable -> next
        // distinct roster model; invalid_output (EHAC-2522) and max_turns (EHAC-3644)
        // -> the pinned validator_review_failover_model when one is set; nothing else,
        // timeout and stall included.
        //
        // `timeout` retries again since owner ruling 4 (2026-10-16): 35 of 39 measured
        // timeouts were mimo-v2.5-pro first attempts at 900s while the other lenses of
        // the same runs finished, so the overrun was the model's. The retry gets at
        // most R/2 and only what the live clock leaves before the validator; with
        // job_timeout_minutes unset it does not happen at all.
        //
        // Re-sending a byte-identical prompt to a model that just hung is not a
        // retry, it is a second copy of the same failure — measured twice on
        // eha_care #3291, 600s each time.
        const execution = await executeLensWithRetry({
          job,
          roster: reviewerRoster,
          validatorReviewFailoverModel,
          deps: {
            // The prompt and the pi inputs are built FROM the job handed back, so
            // a substituted model gets its own prompt label and its own diff
            // budget rather than inheriting the failed model's.
            runAttempt: (activeJob, promptName, overrides) =>
              runPi(lensPromptFor(activeJob), lensInputsFor(activeJob, overrides), undefined, false, { promptName }),
            // Read when an attempt timed out: the live clock since the action started.
            timeoutRetryBudget: () => ({
              runTimeoutSeconds: roleTimeouts.reviewer,
              validatorSeconds: roleTimeouts.validator,
              jobTimeoutMinutes: parsedInputs.jobTimeoutMinutes,
              elapsedSeconds: (Date.now() - actionStartedAt.getTime()) / 1000,
            }),
            promptBudgetFor: (activeJob) => promptBudgetByKey.get(lensPromptKey(activeJob)),
            log: (message) => console.log(message),
            warn: (message) => console.warn(message),
          },
        });
        attemptMetrics.push(...execution.attemptMetrics);
        const lensOutput = sanitize(execution.lensResult.output);
        console.log(
          `[${job.lens.id}] ${execution.lensResult.conclusion} · ${lensOutput.substring(0, 180)}`,
        );
        return { ...execution, lensOutput };
      }),
    );

    retriedLensIdsForSummary = lensRuns.filter(({ retried }) => retried).map(({ job }) => job.lens.id);

    for (const { job, activeJob, lensResult, lensOutput, attempts, failoverUsed } of lensRuns) {
      // Charge for EVERY attempt — a retry spends real money, and a cost report
      // that hides it would understate the run. The pre-execution estimate prices
      // ONE extra reviewer attempt (costEstimateLensJobs), so a run with retries on
      // several lenses can still exceed it; the bound is the attempt count.
      for (const attempt of attempts) {
        runCosts.push(costFromPiResult(attempt));
      }
      // Report ONE metric per lens (the DECISIVE attempt), so the per-lens shape
      // downstream consumers rely on stays 1:1 with the council. When failover
      // succeeded, the logical lens succeeded under the REPLACEMENT model, and
      // both labels are recorded so the census can say which is which.
      runMetrics.push(metricFromPiRun(lensResult, job.role || "reviewer", {
        lensId: job.lens.id,
        lensTitle: job.lens.title,
        assignedModelLabel: job.model.label,
        actualModelLabel: activeJob.model.label,
        failoverUsed,
        attemptCount: attempts.length,
        // Recorded here, BEFORE the council policy is evaluated, so a breached council
        // still says what its finished lenses found (EHAC-3675 groundwork).
        findingsCount: findingsCountOf(lensResult.conclusion, lensOutput),
      }));
    }

    // The tolerance decision, evaluated EXPLICITLY rather than as
    // `failedRequiredReviewLensIds().length > 0`. That boolean scored a council —
    // a redundancy mechanism — as a serial reliability chain, so one hung request
    // blocked the pull request. `failedRequiredReviewLensIds` remains as the
    // census it always was.
    councilPolicy = evaluateCouncilPolicy({
      runs: lensRuns.map(({ job, activeJob, lensResult }) => ({
        role: job.role || "reviewer",
        lensId: job.lens.id,
        modelLabel: activeJob.model.label,
        conclusion: lensResult.conclusion,
      })),
      configuredMaxDegradedLenses: inputs.maxDegradedLenses,
    });
    for (const warning of councilPolicy.warnings) core.warning(`[council] ${warning}`);
    finalizer.update({ councilPolicy });
    console.log(
      `[council] status=${councilPolicy.status} reviewers=${councilPolicy.reviewerLensesTotal} ` +
        `failed=${councilPolicy.reviewerLensesFailed} tolerance=${councilPolicy.effectiveMaxDegradedLenses} ` +
        `(configured ${councilPolicy.configuredMaxDegradedLenses})`,
    );

    if (councilPolicy.status === "breached") {
      const failureMessage = `Council policy breached: ${councilPolicy.message}`;
      if (commentId) {
        try {
          await updateTrackingComment(
            octokit,
            context,
            commentId,
            [
              spinnerHeader(modelLabel, "review failed"),
              "",
              failureMessage,
              `[View run](${jobRunLink})`,
            ].join("\n"),
            trackingModelLabel,
          );
        } catch (err) {
          console.warn("Could not update failed strategy status:", err);
        }
      }
      // EMIT BEFORE FAILING. This is the whole D3 defect: the previous code threw
      // here, the throw escaped run(), and the action exited having set no
      // review_summary_json at all — so the downstream gate saw zero model runs
      // and reported "no evidence a review prompt was ever built" for a review
      // that had produced healthy lens reports. A partial record is what makes
      // the failure diagnosable AND what makes the downstream quorum meaningful.
      core.error(failureMessage);
      finalizer.update({
        costTotal: aggregateCosts(runCosts),
        runs: runMetrics,
        attempts: attemptMetrics,
        promptBudgets: [...promptBudgetByKey.values()],
        retriedLensIds: retriedLensIdsForSummary,
        executedStrategy: reviewPlan.strategy,
        finalModelLabel: reviewPlan.validator.label,
      });
      finalizer.finalize({
        conclusion: "failure",
        terminalReason: "council_policy_breached",
        failureMessage,
      });
      const costTotalOnBreach = aggregateCosts(runCosts);
      core.setOutput("conclusion", "failure");
      core.setOutput("cost_usd", costTotalOnBreach.costUsd.toFixed(6));
      core.setOutput("input_tokens", String(costTotalOnBreach.inputTokens));
      core.setOutput("output_tokens", String(costTotalOnBreach.outputTokens));
      core.setFailed(failureMessage);
      return;
    }

    if (councilPolicy.status === "degraded" && councilPolicy.message) {
      // Never silent. A green with no annotation for a thinner-than-advertised
      // review is the same defect class this gate exists to prevent.
      core.warning(`[council] ${councilPolicy.message}`);
    }

    const reports = lensRuns.map(({ job, activeJob, failoverUsed, lensResult, lensOutput }) => ({
      lens: job.lens,
      // The model that ACTUALLY produced this output, not the assigned one.
      // After a validator-review 404 failover the assigned model produced nothing
      // and its replacement produced the report; attributing the report to the
      // failed model would let the synthesis and the public record agree on the
      // wrong author. (EHAC-2841)
      modelLabel: activeJob.model.label,
      // Failover provenance is part of the evidence: the synthesis must be able
      // to say which model was planned, which one delivered, and that the two
      // differed. Only attached when they differed.
      ...(failoverUsed ? { assignedModelLabel: job.model.label, failoverUsed } : {}),
      output: lensOutput,
      conclusion: lensResult.conclusion,
    }));

    finalInputs = {
      ...piInputs,
      provider: reviewPlan.validator.provider,
      model: reviewPlan.validator.model,
      thinking: inputs.validatorThinking || inputs.thinking,
      // The synthesis is the second VALIDATOR role and runs after the wave; it
      // carries the same validator budget as the audit lens (EHAC-2833).
      runTimeoutSeconds: roleTimeouts.validator,
      tools: piTools,
      mode: "review",
    };
    activeModelLabel = reviewPlan.validator.label;
    prompt = buildSynthesisPrompt({
      data,
      userRequest,
      modelLabel: reviewPlan.validator.label,
      jobRunLink,
      commentId,
      reports,
      repoConfig: effectiveRepoConfig,
      publicModelLabel,
    });
    writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");
    failoverPromptFor = (model) =>
      buildSynthesisPrompt({
        data,
        userRequest,
        modelLabel: model.label,
        jobRunLink,
        commentId,
        reports,
        repoConfig: effectiveRepoConfig,
        publicModelLabel: publicModelLabelFor(model.label),
      });
  }

  const finalModel: ModelSpec = useReviewPlan
    ? reviewPlan.validator
    : { provider: finalInputs.provider, model: finalInputs.model, label: activeModelLabel };
  // One physical final attempt. Each attempt gets its own MCP config, dropped the moment pi
  // exits, and its own cost line: a failover spends real money and the report must show it.
  const runFinalAttempt = async (
    model: ModelSpec,
    promptName: string,
    overrides?: SynthesisAttemptOverrides,
  ): Promise<PiRunResult> => {
    activeModelLabel = model.label;
    let attemptResult: PiRunResult = {
      conclusion: "failure",
      output: "MCP configuration failed",
      turnsUsed: 0,
      providerRetries: 0,
      durationSeconds: 0,
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimated: true,
        modelLabel: model.label,
        source: "unknown",
      },
    };
    try {
      writeMcpConfig();
      attemptResult = await runPi(
        model === finalModel ? prompt : (failoverPromptFor?.(model) ?? prompt),
        {
          ...finalInputs,
          provider: model.provider,
          model: model.model,
          ...(overrides?.runTimeoutSeconds !== undefined ? { runTimeoutSeconds: overrides.runTimeoutSeconds } : {}),
        },
        onProgress,
        mcpEnabled,
        { promptName },
      );
    } catch (err) {
      attemptResult = {
        ...attemptResult,
        output: `Review execution failed: ${(err as Error).message}`,
      };
    } finally {
      // Drop the MCP config (carries GITHUB_TOKEN) the moment pi exits.
      if (mcpConfigPath) {
        try { unlinkSync(mcpConfigPath); } catch { /* already gone */ }
      }
    }
    runCosts.push(costFromPiResult(attemptResult));
    return attemptResult;
  };

  // EHAC-3622: a synthesis that ends stall, invalid_output or (EHAC-3644) max_turns fails over ONCE to the pinned
  // validator_failover_model, on the same lens reports, within what the live job clock
  // still affords. Unset, this is the single attempt it always was.
  const synthesis = await executeSynthesisWithFailover({
    validator: finalModel,
    validatorFailoverModel: useReviewPlan ? validatorFailoverModel : undefined,
    deps: {
      runAttempt: runFinalAttempt,
      retryBudget: () => ({
        validatorSeconds: roleTimeouts.validator,
        jobTimeoutMinutes: parsedInputs.jobTimeoutMinutes,
        elapsedSeconds: (Date.now() - actionStartedAt.getTime()) / 1000,
        jobElapsedSeconds: measuredJobElapsedSeconds(),
      }),
      // The failed attempt's buffered inline comments were never validated by a
      // successful synthesis; only the decisive attempt's findings are posted.
      beforeRetry: () => {
        try { unlinkSync(bufferPath); } catch { /* nothing buffered */ }
      },
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
    },
  });
  const result = synthesis.result;
  activeModelLabel = synthesis.activeModel.label;
  if (synthesis.retried) retriedLensIdsForSummary = [...retriedLensIdsForSummary, "validator"];

  console.log(`── pi ${result.conclusion === "success" ? "completed" : "failed"} ──`);
  const safeOutput = sanitize(result.output);
  const publicReview = preparePublicReviewOutput(result.output, result.conclusion, {
    internalModelLabels: modelLabelRedactionTerms([
      modelLabel,
      inputs.model,
      trackingModelLabel,
      activeModelLabel,
    ]),
    // Redaction is a NO-OP unless an operator configured a public label. With none configured
    // there is nothing to hide, and rewriting internal labels to ANOTHER internal label only
    // mis-attributes the review — measured 2026-09-20: every public council comment named the
    // validator as the Tests lens's model, doubled.
    publicModelLabel: configuredPublicModelLabel(),
  });
  const publicConclusion =
    result.conclusion === "success" && publicReview.usable ? "success" : "failure";
  const publicCoverage = publicReviewCoverage(publicReview.body, publicConclusion, councilPolicy);
  const publicOutput = publicCoverage.body;
  if (publicReview.filtered) {
    console.warn(
      `[review-output] filtered internal delivery text from public review ` +
      `(removed_paragraphs=${publicReview.removedParagraphs})`,
    );
  }
  const parsedFindings = parseReviewFindings(publicOutput);
  // The synthesized review's count, null unless it is a usable review: a failed or
  // unusable synthesis posts GENERIC text, and counting that as 0 would read as "no findings".
  const synthesisFindingsCount = publicConclusion === "success" ? parsedFindings.length : null;
  // ONE decisive validator run, as for a lens: the failover is described on it (assigned vs
  // actual model, attempt count), never split into a second logical run.
  runMetrics.push(metricFromPiRun(result, "validator", {
    assignedModelLabel: finalModel.label,
    actualModelLabel: activeModelLabel,
    failoverUsed: synthesis.failoverUsed,
    attemptCount: synthesis.attempts.length,
    findingsCount: synthesisFindingsCount,
  }));
  // Every physical synthesis attempt. Recording them keeps the attempt history a
  // COMPLETE account of what ran, rather than one that silently stops at the reviewer
  // wave or hides the failed first synthesis behind a successful failover.
  attemptMetrics.push(...synthesis.attemptMetrics);
  const costTotal = aggregateCosts(runCosts);
  const costLine = inputs.showCost ? formatCostLine(costTotal) : "";
  if (result.output) {
    console.log(safeOutput.substring(0, 500) + (safeOutput.length > 500 ? "..." : ""));
  }
  if (inputs.showCost) console.log(costLine);

  // ── Phase 5: Handle results ──────────────────────────────────────────
  // GitHub's hard limit on issue/PR comments is 65,536 chars; leave
  // headroom for the wrapper (header, signature, links).
  const MAX_REVIEW_CHARS = 60_000;
  const truncate = (s: string) =>
    s.length > MAX_REVIEW_CHARS
      ? `${s.slice(0, MAX_REVIEW_CHARS)}\n\n_…review truncated, ${s.length - MAX_REVIEW_CHARS} chars omitted_`
      : s;

  // Always post the review comment first (before git ops, which can fail)
  let reviewBody = "";
  if (commentId) {
    reviewBody = [
      spinnerHeader(activeModelLabel, publicCoverage.status),
      "",
      truncate(publicOutput),
      ...(inputs.showCost ? ["", `_${costLine}_`] : []),
      "",
      `[View run](${jobRunLink})`,
    ].join("\n");

    try {
      await updateTrackingComment(octokit, context, commentId, reviewBody, trackingModelLabel);
    } catch (err) {
      console.warn("Could not update tracking comment, posting new one:", err);
      try {
        await postComment(octokit, context, reviewBody, trackingModelLabel);
      } catch (err2) {
        console.warn("Could not post comment either:", err2);
      }
    }
  }

  // Then handle any code changes pi made (separate from the review comment)
  if (result.conclusion === "success" && workBranch) {
    try {
      // Only count non-lockfile changes as elek's work
      // Filter in JS instead of grep -v to avoid exit code 1 when no matches
      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        stdio: "pipe",
      });

      const relevantChanges = status
        .split("\n")
        .filter((line) => {
          if (!line) return false;
          // Filter out npm install artifacts by exact path prefix, not substring
          const parts = line.trim().split(/\s+/);
          const path = parts.length >= 2 ? parts.slice(1).join(" ") : line;
          return !path.startsWith("package-lock.json") && !path.startsWith("node_modules/");
        })
        .join("\n");

      if (relevantChanges.trim()) {
        commitChanges(`chore(elek): automated changes for #${context.entityNumber}`);
        pushBranch(workBranch);

        const changeNotice = [
          `**${publicModelLabel}** also made code changes:`,
          "",
          `Branch: \`${workBranch}\``,
          `[View changes](https://github.com/${context.repo.fullName}/compare/${baseBranch}...${workBranch})`,
        ].join("\n");

        try {
          await postComment(octokit, context, changeNotice, modelLabel);
        } catch (err) {
          console.warn("Could not post change notice:", err);
        }
      }
    } catch (err) {
      console.warn("Git operations failed:", err);
    }
  }

  // Post PR review if no tracking comment
  if (context.isPR && !commentId) {
    try {
      const reviewOutput = inputs.showCost
        ? `${truncate(publicReview.body)}\n\n_${costLine}_`
        : truncate(publicReview.body);
      await createPRReview(octokit, context, reviewOutput, publicConclusion, activeModelLabel, councilPolicy);
    } catch (err) {
      console.warn("Could not create PR review:", err);
    }
  }

  // Post regular comment for issues without tracking
  if (!context.isPR && !commentId) {
    try {
      await postComment(
        octokit,
        context,
        [
          spinnerHeader(activeModelLabel, publicCoverage.status),
          "",
          truncate(publicOutput),
          ...(inputs.showCost ? ["", `_${costLine}_`] : []),
          "",
          `[View run](${jobRunLink})`,
        ].join("\n"),
        activeModelLabel,
      );
    } catch (err) {
      console.warn("Could not post comment:", err);
    }
  }

  // ── Phase 5b: Drain the inline-comment buffer (MCP-only) ─────────────
  let inlineSummary: PostSummary = { posted: 0, skipped: 0, failed: 0 };
  if (mcpEnabled && context.isPR && existsSync(bufferPath)) {
    try {
      const summary = await postBuffered({
        readBuffer: () => readFileSync(bufferPath, "utf-8"),
        // @actions/github's octokit exposes the API under `.rest` —
        // structurally compatible with PostBufferedOctokit (no cast needed).
        octokit: octokit.rest,
        env: {
          repoOwner: context.repo.owner,
          repoName: context.repo.repo,
          prNumber: String(context.entityNumber),
        },
        log: (m) => console.log(`[post-buffered] ${m}`),
      });
      inlineSummary = summary;
      console.log(
        `[post-buffered] posted=${summary.posted} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    } catch (err) {
      console.warn("post-buffered failed:", (err as Error).message);
    }
  }

  const inlineFallbackBuffer =
    context.isPR && inlineSummary.posted === 0 && (inlineSummary.duplicate ?? 0) === 0
      ? inlineReviewBufferFromFindings(parsedFindings)
      : "";
  if (context.isPR && inlineFallbackBuffer.trim()) {
    try {
      const summary = await postBuffered({
        readBuffer: () => inlineFallbackBuffer,
        // Host-side fallback for models that returned structured findings
        // but did not call the inline-comment MCP tool.
        octokit: octokit.rest,
        env: {
          repoOwner: context.repo.owner,
          repoName: context.repo.repo,
          prNumber: String(context.entityNumber),
        },
        log: (m) => console.log(`[post-findings] ${m}`),
      });
      inlineSummary = mergePostSummaries(inlineSummary, summary);
      console.log(
        `[post-findings] posted=${summary.posted} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    } catch (err) {
      console.warn("post-findings failed:", (err as Error).message);
    }
  }

  if (commentId && reviewBody && (inlineSummary.duplicate ?? 0) > 0) {
    const duplicateNote =
      `_Inline lifecycle: skipped ${inlineSummary.duplicate} duplicate Elek inline finding(s) ` +
      "already visible on this PR._";
    try {
      await updateTrackingComment(
        octokit,
        context,
        commentId,
        [reviewBody, "", duplicateNote].join("\n"),
        trackingModelLabel,
      );
    } catch (err) {
      console.warn("Could not update tracking comment with inline lifecycle note:", err);
    }
  }

  // ── Phase 6: Set outputs ─────────────────────────────────────────────
  core.setOutput("conclusion", result.conclusion);
  core.setOutput("branch_name", workBranch || "");
  core.setOutput("comment_id", commentId ? String(commentId) : "");
  core.setOutput("session_id", result.sessionId || "");
  core.setOutput("summary", publicOutput.substring(0, 1000));
  core.setOutput("cost_usd", costTotal.costUsd.toFixed(6));
  core.setOutput("input_tokens", String(costTotal.inputTokens));
  core.setOutput("output_tokens", String(costTotal.outputTokens));

  finalizer.update({
    mode: resolvedMode.mode,
    requestedStrategy: inputs.reviewStrategy,
    executedStrategy: useReviewPlan ? reviewPlan.strategy : "solo",
    primaryModelLabel: modelLabel,
    finalModelLabel: activeModelLabel,
    commentId,
    branchName: workBranch,
    inlineComments: inlineSummary,
    costTotal,
    runs: runMetrics,
    findings: parsedFindings,
    synthesisFindingsCount,
    promptBudgets: [...promptBudgetByKey.values()],
    retriedLensIds: retriedLensIdsForSummary,
    attempts: attemptMetrics,
    councilPolicy,
  });

  // A successful final synthesis is REQUIRED even when the council ran degraded.
  // A degraded council means one reviewer opinion is missing; a failed validator
  // means nothing reconciled or posted the findings at all, which is not a
  // thinner review but an absent one.
  if (result.conclusion === "failure") {
    finalizer.finalize({
      conclusion: "failure",
      terminalReason: "validator_failed",
      failureMessage: "pi execution failed",
    });
    core.setFailed("pi execution failed");
    return;
  }

  finalizer.finalize({ conclusion: "success", terminalReason: "completed" });
}

run().catch((err) => {
  console.error("Fatal error:", err);
  // Best effort, from whatever state accumulated. An unexpected exception used to
  // exit with no record at all, which is what turned a single hung lens into
  // "no evidence a review prompt was ever built" downstream. The finalizer is
  // idempotent, so this is a no-op when the normal path already emitted.
  try {
    activeFinalizer?.finalize({
      conclusion: "failure",
      terminalReason: "unexpected_error",
      failureMessage: err instanceof Error ? err.message : String(err),
    });
  } catch (finalizeErr) {
    console.error("Could not emit a failure summary:", finalizeErr);
  }
  core.setFailed(`Fatal: ${err.message}`);
  process.exit(1);
});

function parseExistingTrackingCommentId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function mergePostSummaries(a: PostSummary, b: PostSummary): PostSummary {
  const duplicate = (a.duplicate ?? 0) + (b.duplicate ?? 0);
  return {
    posted: a.posted + b.posted,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    ...(duplicate > 0 ? { duplicate } : {}),
  };
}
