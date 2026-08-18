import { describe, expect, it } from "bun:test";
import {
  buildLensPrompt,
  buildSynthesisPrompt,
  downgradeReviewStrategy,
  failedRequiredReviewLensIds,
  parseModelList,
  parseModelSpec,
  parseReviewLensList,
  resolveReviewPlan,
  resolveReviewPlanSupport,
  resolveReviewStrategy,
  selectReviewPlanWithinBudget,
  resolveLensRetry,
  selectFailoverModel,
  distinctModels,
  normalizeModelIdentity,
  FAILURE_RETRY_POLICY,
  MAX_LENS_ATTEMPTS,
} from "../src/review/strategy";
import type { GitHubData } from "../src/github/data";
import type { ActionInputs } from "../src/types";
import type { ReviewCost } from "../src/review/cost";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  systemPrompt: "",
  maxTurns: 20,
  runTimeoutSeconds: 600,
  stallTimeoutSeconds: 0,
  tools: "",
  configPath: ".elek.yml",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  reviewLenses: "",
  reviewAgentCount: undefined,
  advisorModel: "",
  advisorThinking: "",
  validatorModel: "",
  validatorThinking: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
  maxCostUsd: undefined,
};

describe("required review coverage", () => {
  const lens = (id: string) => ({ id, title: id, focus: id });

  it("fails closed for failed reviewer lanes but not an optional advisor lane", () => {
    expect(
      failedRequiredReviewLensIds([
        { job: { lens: lens("risk"), role: "reviewer" }, conclusion: "failure" },
        { job: { lens: lens("tests"), role: "reviewer" }, conclusion: "success" },
        {
          job: { lens: lens("advisor-independent-audit"), role: "validator-review" },
          conclusion: "failure",
        },
      ]),
    ).toEqual(["risk"]);
  });

  it("allows synthesis when all required reviewer lanes succeeded", () => {
    expect(
      failedRequiredReviewLensIds([
        { job: { lens: lens("risk"), role: "reviewer" }, conclusion: "success" },
        { job: { lens: lens("tests"), role: "reviewer" }, conclusion: "success" },
      ]),
    ).toEqual([]);
  });
});

const dataFixture: GitHubData = {
  type: "pr",
  title: "Improve review orchestration",
  body: "",
  author: "alice",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+export const ok = true;",
  comments: ["[github-actions]: prior summary"],
  reviewComments: ["src/a.ts:1 prior inline finding"],
  labels: [],
  assignees: [],
  entityNumber: 7,
  pr: { headRef: "feature/review", baseRef: "main" },
};

describe("review strategy", () => {
  it("keeps solo as the safe default", () => {
    expect(resolveReviewStrategy(undefined)).toBe("solo");
    expect(resolveReviewStrategy("nonsense")).toBe("solo");
  });

  it("accepts useful aliases without exposing the internal naming", () => {
    expect(resolveReviewStrategy("dual")).toBe("crosscheck");
    expect(resolveReviewStrategy("swarm")).toBe("council");
    expect(resolveReviewStrategy("thermo-nuclear")).toBe("thermos");
    expect(resolveReviewStrategy("multi-agent")).toBe("thermos");
  });

  it("parses provider-qualified model specs as self-routing pi models", () => {
    const spec = parseModelSpec("openrouter/moonshotai/kimi-k2.7-code", baseInputs);
    expect(spec).toEqual({
      provider: "openrouter",
      model: "openrouter/moonshotai/kimi-k2.7-code",
      label: "openrouter/moonshotai/kimi-k2.7-code",
    });
  });

  it("treats trailing-slash provider specs as provider defaults", () => {
    expect(parseModelSpec("openrouter/", baseInputs)).toEqual({
      provider: "openrouter",
      model: "",
      label: "openrouter",
    });
    expect(parseModelSpec("openrouter//moonshotai/kimi-k2.7-code/", baseInputs)).toEqual({
      provider: "openrouter",
      model: "openrouter/moonshotai/kimi-k2.7-code",
      label: "openrouter/moonshotai/kimi-k2.7-code",
    });
  });

  it("normalizes leading-slash model specs", () => {
    expect(parseModelSpec("/deepseek-v4-pro", baseInputs)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      label: "deepseek/deepseek-v4-pro",
    });
    expect(parseModelSpec("/", baseInputs)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      label: "deepseek/deepseek-v4-pro",
    });
  });

  it("parses unqualified model specs against the primary provider", () => {
    expect(parseModelSpec("deepseek-v4-flash", baseInputs)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      label: "deepseek/deepseek-v4-flash",
    });
  });

  it("builds a crosscheck plan with two named lenses", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "crosscheck",
      reviewModels: "deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code",
      validatorModel: "deepseek/deepseek-v4-pro",
    });

    expect(plan.strategy).toBe("crosscheck");
    expect(plan.reusedModels).toBe(false);
    expect(plan.jobs.map((j) => j.lens.id)).toEqual(["risk", "design"]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k2.7-code",
    ]);
    expect(plan.validator.label).toBe("deepseek/deepseek-v4-pro");
    expect(plan.validatorReview?.lens.id).toBe("validator-self-review");
    expect(plan.validatorReview?.model.label).toBe("deepseek/deepseek-v4-pro");
  });

  it("uses a distinct advisor model without changing the final validator", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "crosscheck",
      advisorModel: "openai/gpt-5.6-sol",
      validatorModel: "together/moonshotai/Kimi-K3",
    });

    expect(plan.validatorReview).toMatchObject({
      role: "validator-review",
      lens: { id: "advisor-independent-audit" },
      model: { label: "openai/gpt-5.6-sol" },
    });
    expect(plan.validator.label).toBe("together/moonshotai/Kimi-K3");
  });

  it("disables the parallel advisor when advisor_model is off", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "crosscheck",
      advisorModel: "off",
      validatorModel: "together/moonshotai/Kimi-K3",
    });

    expect(plan.validatorReview).toBeUndefined();
    expect(plan.jobs).toHaveLength(2);
    expect(plan.validator.label).toBe("together/moonshotai/Kimi-K3");
  });

  it("selects a bounded domain-specific lens council", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "thermos",
      reviewLenses: "security-correctness,contract-drift,mobile-runtime",
      reviewAgentCount: 8,
    });

    expect(plan.jobs.map((job) => job.lens.id)).toEqual([
      "security-correctness",
      "contract-drift",
      "mobile-runtime",
    ]);
  });

  it("rejects unknown review lens identifiers and removes duplicates", () => {
    expect(parseReviewLensList("contract-drift, contract-drift, mobile-runtime").map((lens) => lens.id)).toEqual([
      "contract-drift",
      "mobile-runtime",
    ]);
    expect(() => parseReviewLensList("contract-drift,not-a-lens")).toThrow(
      "Unknown review_lenses: not-a-lens",
    );
  });

  it("rejects an explicit lens council that exceeds the strategy limit", () => {
    expect(() => resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "crosscheck",
      reviewLenses: "security-correctness,contract-drift,mobile-runtime",
    })).toThrow(
      "review_strategy=crosscheck supports at most 2 review_lenses, received 3",
    );
  });

  it("builds a council plan with four lenses and cycles provided models", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "council",
      reviewModels: "deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code",
    });

    expect(plan.jobs.map((j) => j.lens.id)).toEqual([
      "risk",
      "design",
      "tests",
      "operations",
    ]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k2.7-code",
      "deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k2.7-code",
    ]);
    expect(plan.reusedModels).toBe(true);
    expect(plan.validatorReview?.role).toBe("validator-review");
  });

  it("builds a thermos plan with N parallel audit agents and advisor review", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "thermos",
      reviewAgentCount: 6,
      reviewModels: "together/moonshotai/Kimi-K2.7-Code,deepseek/deepseek-v4-pro,openai/gpt-5.5",
      validatorModel: "openai/gpt-5.5",
    });

    expect(plan.strategy).toBe("thermos");
    expect(plan.jobs).toHaveLength(6);
    expect(plan.jobs.map((j) => j.lens.id)).toEqual([
      "security-correctness",
      "side-effects",
      "devex-config",
      "feature-gates",
      "tests-ops",
      "independent-audit-6",
    ]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "together/moonshotai/Kimi-K2.7-Code",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
      "together/moonshotai/Kimi-K2.7-Code",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
    ]);
    expect(plan.reusedModels).toBe(true);
    expect(plan.validator.label).toBe("openai/gpt-5.5");
    expect(plan.validatorReview).toMatchObject({
      role: "validator-review",
      lens: { id: "validator-self-review" },
      model: { label: "openai/gpt-5.5" },
    });
  });

  it("downgrades expensive strategies one step at a time", () => {
    expect(downgradeReviewStrategy("thermos")).toBe("council");
    expect(downgradeReviewStrategy("council")).toBe("crosscheck");
    expect(downgradeReviewStrategy("crosscheck")).toBe("solo");
    expect(downgradeReviewStrategy("solo")).toBeUndefined();
  });

  it("keeps the requested strategy when no budget cap is configured", () => {
    let estimates = 0;
    const plan = resolveReviewPlan({ ...baseInputs, reviewStrategy: "council" });
    const result = selectReviewPlanWithinBudget({
      inputs: { ...baseInputs, reviewStrategy: "council" },
      initialPlan: plan,
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => {
        estimates++;
        return [reviewCost(1)];
      },
    });

    expect(result.plan.strategy).toBe("council");
    expect(result.support.enabled).toBe(true);
    expect(result.events).toEqual([]);
    expect(estimates).toBe(0);
  });

  it("keeps the requested strategy when the known input estimate is within budget", () => {
    const plan = resolveReviewPlan({ ...baseInputs, reviewStrategy: "crosscheck" });
    const result = selectReviewPlanWithinBudget({
      inputs: { ...baseInputs, reviewStrategy: "crosscheck", maxCostUsd: 0.05 },
      initialPlan: plan,
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => [reviewCost(0.01)],
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.support.enabled).toBe(true);
    expect(result.events.map((event) => event.level)).toEqual(["log"]);
  });

  it("downgrades one step when the downgraded strategy fits the budget", () => {
    const inputs = { ...baseInputs, reviewStrategy: "council", maxCostUsd: 0.05 };
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: (plan) => [reviewCost(plan.strategy === "council" ? 0.10 : 0.01)],
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.support.enabled).toBe(true);
    expect(result.events.some((event) => event.message.includes("downgrading to crosscheck"))).toBe(true);
  });

  it("downgrades to solo when every multi-lens strategy exceeds the budget", () => {
    const inputs = { ...baseInputs, reviewStrategy: "council", maxCostUsd: 0.05 };
    const estimatedStrategies: string[] = [];
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: (plan) => {
        estimatedStrategies.push(plan.strategy);
        return [reviewCost(0.10)];
      },
    });

    expect(result.plan.strategy).toBe("solo");
    expect(result.support.enabled).toBe(false);
    expect(estimatedStrategies).toEqual(["council", "crosscheck"]);
    expect(result.events.filter((event) => event.message.includes("downgrading")).length).toBe(2);
  });

  it("reduces custom thermos lenses deliberately during automatic budget downgrades", () => {
    const inputs = {
      ...baseInputs,
      reviewStrategy: "thermos",
      reviewLenses: "security-correctness,side-effects,devex-config,contract-drift,mobile-runtime",
      maxCostUsd: 0.05,
    };
    const estimatedStrategies: string[] = [];
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: (plan) => {
        estimatedStrategies.push(plan.strategy);
        return [reviewCost(0.10)];
      },
    });

    expect(result.plan.strategy).toBe("solo");
    expect(result.support.enabled).toBe(false);
    expect(estimatedStrategies).toEqual(["thermos", "council", "crosscheck"]);
    expect(result.events.filter((event) => event.message.includes("reducing review_lenses")).map((event) => event.message)).toEqual([
      "[cost] reducing review_lenses from 5 to 4 for automatic downgrade to council.",
      "[cost] reducing review_lenses from 4 to 2 for automatic downgrade to crosscheck.",
      "[cost] reducing review_lenses from 2 to 0 for automatic downgrade to solo.",
    ]);
  });

  it("downgrades when the known priced portion already exceeds the budget despite unknown rates", () => {
    const inputs = { ...baseInputs, reviewStrategy: "crosscheck", maxCostUsd: 0.05 };
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => [reviewCost(0.06), reviewCost(0, "unknown")],
    });

    expect(result.plan.strategy).toBe("solo");
    expect(result.events.some((event) => event.message.includes("incomplete pricing"))).toBe(true);
  });

  it("warns but keeps the strategy when unknown rates leave the known portion within budget", () => {
    const inputs = { ...baseInputs, reviewStrategy: "crosscheck", maxCostUsd: 0.05 };
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => [reviewCost(0.01), reviewCost(0, "unknown")],
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.events.map((event) => event.level)).toEqual(["warn", "log"]);
  });

  it("uses the provider default model when no reviewer model list is supplied", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      model: "",
      reviewStrategy: "crosscheck",
      reviewModels: "",
    });

    expect(plan.jobs.map((j) => j.model)).toEqual([
      { provider: "deepseek", model: "", label: "deepseek" },
      { provider: "deepseek", model: "", label: "deepseek" },
    ]);
  });

  it("drops empty model list entries", () => {
    expect(parseModelList(" deepseek/a, ,openrouter/b ", baseInputs).map((m) => m.label)).toEqual([
      "deepseek/a",
      "openrouter/b",
    ]);
  });

  it("enables non-solo strategies only for PR review mode", () => {
    expect(resolveReviewPlanSupport("crosscheck", { isPR: true, mode: "review" })).toEqual({
      enabled: true,
    });
  });

  it("warns when a non-solo strategy is requested for review+edit", () => {
    const support = resolveReviewPlanSupport("crosscheck", {
      isPR: true,
      mode: "review+edit",
    });

    expect(support.enabled).toBe(false);
    expect(support.warning).toContain("only supported in mode=review");
    expect(support.warning).toContain("mode=review+edit");
  });

  it("warns when a non-solo strategy is requested outside PR context", () => {
    const support = resolveReviewPlanSupport("council", {
      isPR: false,
      mode: "review",
    });

    expect(support.enabled).toBe(false);
    expect(support.warning).toContain("requires a pull request");
  });

  it("builds a lens prompt with the lens focus and diff context", () => {
    const prompt = buildLensPrompt({
      data: dataFixture,
      userRequest: "",
      lens: {
        id: "risk",
        title: "Risk Review",
        focus: "Correctness and security.",
      },
      modelLabel: "deepseek/deepseek-v4-pro",
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: ["docs/**"],
        excludePaths: [],
        prioritySourceExtensions: [],
        instructions: ["Treat auth changes as security-sensitive."],
      },
    });

    expect(prompt).toContain("<elek_config>");
    expect(prompt).toContain("severity_threshold: important");
    expect(prompt).toContain("- Treat auth changes as security-sensitive.");
    expect(prompt).toContain("Your lens: Risk Review");
    expect(prompt).toContain("Focus: Correctness and security.");
    expect(prompt).toContain("Available tools: `read`, `grep`, `find`, `ls`");
    expect(prompt).toContain("Do not paste raw diff blocks into your candidate report");
    expect(prompt).toContain("Do not claim external packages, GitHub Actions");
    expect(prompt).toContain("Thermos-style audit calibration:");
    expect(prompt).toContain("Never overstate severity; false positives are review failures.");
    expect(prompt).toContain("Every finding must include severity, confidence, evidence, impact, and a concrete fix.");
    expect(prompt).toContain("Finding acceptance gates:");
    expect(prompt).toContain("A finding must identify a concrete failure path from changed code");
    expect(prompt).toContain("Reject findings that contradict the diff, surrounding repo context, or already-visible comments.");
    expect(prompt).toContain("- Confidence: high|medium");
    expect(prompt).toContain("Review this pull request.");
    expect(prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(prompt).toContain("(no description)");
    expect(prompt).toContain("<comments>");
    expect(prompt).toContain("<review_comments>");
  });

  it("can hide discussion from independent lens prompts for fresh audits", () => {
    const prompt = buildLensPrompt({
      data: dataFixture,
      userRequest: "",
      lens: {
        id: "security-correctness",
        title: "Security & Correctness Audit",
        focus: "Bugs and security.",
      },
      modelLabel: "openai/gpt-5.5",
      includeDiscussion: false,
    });

    expect(prompt).not.toContain("<comments>");
    expect(prompt).not.toContain("<review_comments>");
    expect(prompt).toContain("Do your audit with fresh eyes.");
  });

  it("uses the correct fallback user request for issue lens prompts", () => {
    const prompt = buildLensPrompt({
      data: { ...dataFixture, type: "issue", diff: undefined, pr: undefined },
      userRequest: "",
      lens: {
        id: "operations",
        title: "Operational Review",
        focus: "Rollout safety.",
      },
      modelLabel: "deepseek/deepseek-v4-pro",
    });

    expect(prompt).toContain("Review this issue.");
    expect(prompt).toContain("(diff unavailable; inspect files from the workspace if needed)");
  });

  it("builds a synthesis prompt with candidate reports and visible comment context", () => {
    const prompt = buildSynthesisPrompt({
      data: dataFixture,
      userRequest: "focus on regressions",
      modelLabel: "deepseek/deepseek-v4-pro",
      jobRunLink: "https://github.com/selimozten/elek/actions/runs/1",
      commentId: 123,
      reports: [
        {
          lens: { id: "risk", title: "Risk Review", focus: "Correctness." },
          modelLabel: "deepseek/deepseek-v4-pro",
          output: "Potential issue in src/a.ts",
          conclusion: "success",
        },
        {
          lens: { id: "design", title: "Design Review", focus: "Maintainability." },
          modelLabel: "openrouter/moonshotai/kimi-k2.7-code",
          output: "",
          conclusion: "failure",
        },
      ],
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: ["docs/**"],
        excludePaths: [],
        prioritySourceExtensions: [],
        instructions: ["Treat auth changes as security-sensitive."],
      },
    });

    expect(prompt).toContain("<elek_config>");
    expect(prompt).toContain("ignore_paths:");
    expect(prompt).toContain("Treat existing comments and review comments as already-visible context");
    expect(prompt).toContain("Do not surface low-confidence findings.");
    expect(prompt).toContain("Finding acceptance gates:");
    expect(prompt).toContain("Reject findings that depend on unverified external facts");
    expect(prompt).toContain("drop it instead of posting a caveat.");
    expect(prompt).toContain("Fix: the smallest concrete change required");
    expect(prompt).toContain("Do not surface claims that external packages");
    expect(prompt).toContain("temporary workflow-test scaffolding");
    expect(prompt).toContain("omitted or disabled review-cost budget");
    expect(prompt).toContain("### Available tools (via the `mcp` proxy)");
    expect(prompt).toContain('mcp({tool: "elek_review_create_inline_comment"');
    expect(prompt).toContain("Optional fields: `side`, `startLine`, and `commit_id`.");
    expect(prompt).toContain("validates its current diff anchor");
    expect(prompt).toContain("`args` is a JSON STRING");
    expect(prompt).toContain("Elek can post host-side inline fallbacks if tool delivery fails.");
    expect(prompt).toContain("only this orchestrator run can publish final findings");
    expect(prompt).toContain("do not mention that failure in the public review");
    expect(prompt).toContain("Never include thinking traces");
    expect(prompt).toContain('<reviewer_report lens="risk" title="Risk Review"');
    expect(prompt).toContain('<reviewer_report lens="design" title="Design Review"');
    expect(prompt).toContain("Potential issue in src/a.ts");
    expect(prompt).toContain("(no output)");
    expect(prompt).toContain("<comments>");
    expect(prompt).toContain("<review_comments>");
    expect(prompt).toContain("focus on regressions");
    expect(prompt).toContain("comment_id: 123");
  });

  it("uses the public model label in final synthesis output instructions", () => {
    const prompt = buildSynthesisPrompt({
      data: dataFixture,
      userRequest: "",
      modelLabel: "deepseek/deepseek-v4-pro",
      publicModelLabel: "elek",
      jobRunLink: "https://github.com/selimozten/elek/actions/runs/1",
      reports: [],
    });

    expect(prompt).toContain("Final model: deepseek/deepseek-v4-pro");
    expect(prompt).toContain("End with: elek · https://github.com/selimozten/elek/actions/runs/1");
    expect(prompt).not.toContain("End with: deepseek/deepseek-v4-pro");
  });

  it("uses the validator model's context budget for final synthesis prompts", () => {
    const longData = {
      ...dataFixture,
      diff: `diff --git a/src/a.ts b/src/a.ts\n${"+x\n".repeat(200_000)}`,
      comments: [],
      reviewComments: [],
    };

    const prompt = buildSynthesisPrompt({
      data: longData,
      userRequest: "",
      modelLabel: "deepseek/deepseek-v4-pro",
      jobRunLink: "https://github.com/selimozten/elek/actions/runs/1",
      reports: [],
    });

    expect(prompt).toContain("... diff truncated by file for prompt budget");
    expect(prompt.length).toBeLessThan(340_000);
  });
});

function reviewCost(costUsd: number, source: ReviewCost["source"] = "builtin"): ReviewCost {
  return {
    inputTokens: 100,
    outputTokens: 0,
    costUsd,
    estimated: true,
    modelLabel: "deepseek/deepseek-v4-pro",
    source,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Typed, bounded retry and distinct-model failover (EHAC-2231, D2).
 * ──────────────────────────────────────────────────────────────────────────── */

const PRO = { provider: "deepseek", model: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" };
const MIMO = { provider: "xiaomi", model: "xiaomi/mimo-v2.5-pro", label: "xiaomi/mimo-v2.5-pro" };
const FLASH = { provider: "deepseek", model: "deepseek/deepseek-v4-flash", label: "deepseek/deepseek-v4-flash" };
const ROSTER = [PRO, MIMO, FLASH];

describe("normalizeModelIdentity", () => {
  it("collapses routing prefixes so one model is one identity", () => {
    // elek's own modelLabelFor produces the second spelling from the first, so
    // treating them as distinct would let a failover pick the model that just failed.
    expect(normalizeModelIdentity({ provider: "openrouter", model: "openrouter/deepseek/deepseek-v4-pro" }))
      .toBe(normalizeModelIdentity(PRO));
    expect(normalizeModelIdentity({ provider: "deepseek", model: "DeepSeek/DeepSeek-V4-Pro" }))
      .toBe(normalizeModelIdentity(PRO));
    expect(normalizeModelIdentity({ provider: "deepseek", model: "deepseek//deepseek-v4-pro/" }))
      .toBe(normalizeModelIdentity(PRO));
  });

  it("keeps genuinely different models apart", () => {
    expect(normalizeModelIdentity(PRO)).not.toBe(normalizeModelIdentity(FLASH));
    expect(normalizeModelIdentity(PRO)).not.toBe(normalizeModelIdentity(MIMO));
  });

  it("identifies a provider-default model by its provider", () => {
    expect(normalizeModelIdentity({ provider: "anthropic", model: "" })).toBe("provider:anthropic");
  });
});

describe("distinctModels", () => {
  it("drops duplicate spellings while preserving roster order", () => {
    const roster = [PRO, { provider: "openrouter", model: "openrouter/deepseek/deepseek-v4-pro", label: "openrouter/deepseek/deepseek-v4-pro" }, MIMO];
    expect(distinctModels(roster).map((m) => m.label)).toEqual([PRO.label, MIMO.label]);
  });
});

describe("selectFailoverModel", () => {
  it("chooses the next distinct model deterministically and wraps once", () => {
    expect(selectFailoverModel({ roster: ROSTER, assigned: PRO })!.label).toBe(MIMO.label);
    expect(selectFailoverModel({ roster: ROSTER, assigned: MIMO })!.label).toBe(FLASH.label);
    // Last entry wraps to the first — once.
    expect(selectFailoverModel({ roster: ROSTER, assigned: FLASH })!.label).toBe(PRO.label);
  });

  it("never returns the same normalized model under a different spelling", () => {
    const aliased = { provider: "openrouter", model: "openrouter/deepseek/deepseek-v4-pro", label: "openrouter/deepseek/deepseek-v4-pro" };
    expect(selectFailoverModel({ roster: [PRO, aliased], assigned: PRO })).toBeUndefined();
  });

  it("offers no failover for a single-model roster", () => {
    expect(selectFailoverModel({ roster: [PRO], assigned: PRO })).toBeUndefined();
    expect(selectFailoverModel({ roster: [], assigned: PRO })).toBeUndefined();
  });
});

describe("resolveLensRetry", () => {
  const base = { role: "reviewer" as const, conclusion: "failure" as const, attemptsSoFar: 1, assignedModel: PRO, roster: ROSTER };

  it("moves stall, max_turns and invalid_output to the next distinct model", () => {
    for (const failureClass of ["stall", "max_turns", "invalid_output"] as const) {
      const decision = resolveLensRetry({ ...base, failureClass });
      expect(decision.retry).toBe(true);
      expect(decision.failover).toBe(true);
      expect(decision.model!.label).toBe(MIMO.label);
    }
  });

  it("retries a transient provider fault on the SAME model", () => {
    const decision = resolveLensRetry({ ...base, failureClass: "provider_transient" });
    expect(decision.retry).toBe(true);
    expect(decision.failover).toBe(false);
    expect(decision.model!.label).toBe(PRO.label);
  });

  it("never retries a timeout — a wall-clock overrun is a property of the PROMPT", () => {
    // FALSIFIED BY MEASUREMENT, not reasoned: eha_care #3680 run 32105023640 issued
    // four timeout retries on four DIFFERENT models; three timed out again and the
    // fourth returned invalid_output. Every failing attempt was streaming
    // continuously, so none of it was a stall. Moving models cannot fix a prompt
    // that does not fit the budget — it just spends a second budget proving it.
    const decision = resolveLensRetry({ ...base, failureClass: "timeout" });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('failure class "timeout" is not retried');

    // PAIRED DIRECTION: stall, which IS model-specific, still moves models. If this
    // ever goes false too, the failover mechanism has been switched off wholesale
    // rather than narrowed.
    const stall = resolveLensRetry({ ...base, failureClass: "stall" });
    expect(stall.retry).toBe(true);
    expect(stall.failover).toBe(true);
  });

  it("never retries permanent, process or unclassified failures", () => {
    for (const failureClass of ["provider_permanent", "process_error", "unknown"] as const) {
      expect(resolveLensRetry({ ...base, failureClass }).retry).toBe(false);
    }
    // An ABSENT class is treated as `unknown`, not as "probably retryable".
    expect(resolveLensRetry({ ...base, failureClass: undefined }).retry).toBe(false);
  });

  it("fails closed instead of retrying when the roster offers no distinct fallback", () => {
    const decision = resolveLensRetry({ ...base, failureClass: "stall", roster: [PRO] });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("roster offers none");
  });

  it("still permits a same-model transient retry on a single-model roster", () => {
    const decision = resolveLensRetry({ ...base, failureClass: "provider_transient", roster: [PRO] });
    expect(decision.retry).toBe(true);
    expect(decision.model!.label).toBe(PRO.label);
  });

  it("permits exactly ONE outer retry, never a hidden third attempt", () => {
    expect(MAX_LENS_ATTEMPTS).toBe(2);
    // ...and for `timeout` the effective bound is ONE attempt, not two, which is
    // what brings the serial worst case back under the job cap.
    expect(FAILURE_RETRY_POLICY.timeout.retry).toBe(false);
    expect(resolveLensRetry({ ...base, failureClass: "stall", attemptsSoFar: 1 }).retry).toBe(true);
    expect(resolveLensRetry({ ...base, failureClass: "stall", attemptsSoFar: 2 }).retry).toBe(false);
    expect(resolveLensRetry({ ...base, failureClass: "provider_transient", attemptsSoFar: 2 }).retry).toBe(false);
  });

  it("never retries a successful attempt or the validator-review lane", () => {
    expect(resolveLensRetry({ ...base, conclusion: "success", failureClass: undefined }).retry).toBe(false);
    expect(resolveLensRetry({ ...base, role: "validator-review", failureClass: "stall" }).retry).toBe(false);
    // ...and validator-review is still excluded from the required-failure set.
    expect(
      failedRequiredReviewLensIds([
        { job: { lens: { id: "risk", title: "R", focus: "f" }, role: "validator-review" }, conclusion: "failure" },
      ]),
    ).toEqual([]);
  });

  it("keeps the retry matrix TOTAL over the failure taxonomy", () => {
    // A new failure class that nobody adds a policy row for would otherwise fall
    // through to whatever `undefined` happens to mean at the call site.
    const classes = ["stall", "timeout", "max_turns", "invalid_output", "provider_transient", "provider_permanent", "process_error", "unknown"];
    expect(Object.keys(FAILURE_RETRY_POLICY).sort()).toEqual(classes.sort());
  });

  it("still fails the review closed when both attempts fail", () => {
    expect(
      failedRequiredReviewLensIds([
        { job: { lens: { id: "risk", title: "R", focus: "f" }, role: "reviewer" }, conclusion: "failure" },
      ]),
    ).toEqual(["risk"]);
  });
});

describe("diff prompt budget reporting", () => {
  const lens = { id: "risk", title: "Risk Review", focus: "Correctness and security." };

  it("reports the budget the packer actually received, not a re-derived one", () => {
    const reports: Array<{ modelLabel: string; diffPromptBudgetChars: number; reservedChars: number; excludePaths: string[] }> = [];
    buildLensPrompt({
      data: dataFixture,
      userRequest: "",
      lens,
      modelLabel: "deepseek/deepseek-v4-pro",
      repoConfig: { ignorePaths: [], excludePaths: [".planning/**"], prioritySourceExtensions: [], instructions: [] },
      onBudget: (report) => reports.push(report),
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].excludePaths).toEqual([".planning/**"]);
    // Reservation is real and non-zero, so the budget must be BELOW the flat
    // model budget — the exact desync that let the gate assume a larger window
    // than the reviewer had.
    expect(reports[0].reservedChars).toBeGreaterThan(0);
    expect(reports[0].diffPromptBudgetChars).toBeLessThan(320_000);
    expect(reports[0].diffPromptBudgetChars).toBe(
      Math.max(8_000, 320_000 - reports[0].reservedChars),
    );
  });

  it("reports a larger budget for a model with a larger input window", () => {
    const seen: number[] = [];
    for (const modelLabel of ["deepseek/deepseek-v4-pro", "moonshotai/kimi-k3"]) {
      buildLensPrompt({
        data: dataFixture,
        userRequest: "",
        lens,
        modelLabel,
        repoConfig: { ignorePaths: [], excludePaths: [], prioritySourceExtensions: [], instructions: [] },
        onBudget: (report) => seen.push(report.diffPromptBudgetChars),
      });
    }
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });
});
