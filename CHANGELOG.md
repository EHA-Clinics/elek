# Changelog

All notable changes to elek will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Update pi coding agent to 0.83.0 for native Together metadata for Kimi K3
  and GLM-5.2, pi-mcp-adapter to 2.15.0, and the MCP SDK to 1.30.0.
- Give review runs a noninteractive, read-only reviewer contract so agents
  converge after verifying concrete findings instead of exploring
  indefinitely.

### Added

- Report provider retry counts in per-run review metrics and action logs.
- `stall_timeout_seconds`: a stream-idle watchdog, independent of the wall-clock
  `run_timeout_seconds`. A run that emits no valid pi stream event for the
  threshold is terminated and reported with failure class `stall`, which a
  wall-clock timer alone cannot distinguish from genuinely slow work. Defaults to
  `0` (disabled); disabled in `ELEK_PI_TEXT_MODE`, where `pi -p` legitimately
  emits nothing until it finishes.
- A total failure taxonomy on `PiRunResult` — `stall`, `timeout`, `max_turns`,
  `invalid_output`, `provider_transient`, `provider_permanent`, `process_error`,
  `unknown` — plus `terminationReason` for the subset elek causes itself.
  Provider classes are derived from structured status codes only, never from
  message text.
- Per-run stream telemetry (`timeToFirstEventSeconds`, `maxIdleSecondsObserved`,
  `streamEventCount`, `malformedLineCount`, `lastEventType`) so a stall threshold
  can be calibrated from successful runs instead of guessed.
- Typed, bounded lens retry with distinct-model failover. `stall`, `timeout`,
  `max_turns` and `invalid_output` retry ONCE on the next distinct reviewer model;
  `provider_transient` retries once on the same model; `provider_permanent`,
  `process_error` and `unknown` do not retry at all. A model substitution rebuilds
  the whole `ReviewJob`, so the replacement prompt names the replacement model and
  receives that model's diff budget.
- `attempts[]` in the review summary: every PHYSICAL attempt with its assigned
  model, actual model, failover flag, failure class, cost and prompt budget.
  `modelRuns[]` still carries one DECISIVE entry per logical lens, so quorum
  arithmetic stays 1:1 with the council.

- `max_degraded_lenses`: how many reviewer lenses may fail while the review still
  completes. Default `0` (strict, byte-identical to previous releases). Validator
  roles never consume it, a wiped reviewer panel and an unclassifiable failed run
  are never tolerated, and an invalid value resolves to `0` with a warning — a
  misconfigured tolerance must never widen what the review accepts. A degraded run
  exits successfully but emits a warning naming every failed lens, its assigned
  model, its actual model and its terminal failure class.
- `review.terminalReason`, `review.skipReason` and `councilPolicy` in the review
  summary, so a consumer can tell "the review declined" from "the review broke
  before it started" instead of inferring it from an empty output.

### Changed

- Retrying a failed lens no longer re-sends a byte-identical prompt to the model
  that just failed. That was strictly worse than not retrying for a hung request:
  it spent a second full wall-clock budget reproducing the same hang.
- The council tolerance decision is an explicit policy evaluation rather than
  `failedRequiredReviewLensIds().length > 0`.

### Fixed

- **A failed required lens no longer exits without a review summary.** elek used
  to `throw` on a failed required lane; the throw escaped `run()` and the action
  exited having set no `review_summary_json` at all. A downstream consumer then
  saw zero model runs and could only report that no review prompt was ever built —
  for a run that had produced healthy lens reports. Every supported terminal path
  now goes through one idempotent finalizer that emits at most once: completion,
  explicit decline, configuration failure, council-policy breach, validator
  failure, and any unexpected exception after the event context is parsed. Only
  an unsupported event, which has no entity to describe, still emits nothing.

### Fixed

- Fall back to live repository permissions when GitHub webhook payloads contain
  stale or missing actor-association data, while keeping explicit allowlists and
  bot filters authoritative.

## [1.1.4] - 2026-06-21

### Changed

- Sharpen the public README pitch around review-only AI for pull requests and
  move one-minute setup above the advanced workflow reference.
- Hide hosted/internal model names from public review footer instructions when
  `ELEK_PUBLIC_MODEL_LABEL` is configured, while preserving internal model
  labels for tracking and analytics.
- Redact configured internal model labels from public review output before
  posting comments.

### Fixed

- Strip model-prefixed run footers from model-generated public review output.

## [1.1.3] - 2026-06-19

### Added

- Brand guide documenting logo assets, palette, voice, and usage rules.
- Minimal social/brand card asset for repository and launch materials.
- Estimated token usage and review cost reporting in final comments and
  action outputs.
- `show_cost` and `cost_rates` inputs for transparent BYOK pricing.
- Product research and roadmap notes comparing elek's direction with current
  AI review tools.
- Shared review finding contract requiring severity, confidence, evidence,
  impact, and a concrete fix for surfaced findings.
- Repo-local `.elek.yml` config for review defaults, severity policy, ignored
  paths, and extra reviewer instructions.
- Zero-dependency `elek-init` setup helper for generating a starter workflow
  and repo review policy.
- Machine-readable review summary JSON output with duration, model labels,
  per-run cost, pricing source, and inline-comment posting counts.

### Changed

- Refresh elek logo, wordmark, and tracking-comment spinner with a warmer,
  more minimal identity system.
- Tighten the README hero around the review-only positioning.
- Render the elek mark and name in tracking/final review comment headers.
- Document why default workflow comments still appear as `github-actions[bot]`
  and how to use a GitHub App or bot token for a custom avatar.
- Correct agent docs to distinguish GitHub Actions workflows from Dependabot
  configuration.
- Clarify multi-agent review strategy docs and prompts around the orchestrator
  model as the final validator and posting reviewer.
- Preserve requested multi-agent review strategies for large pull requests by
  warning on size thresholds instead of silently downgrading to solo review.
- Prefer representative prioritized diff slices for large prompts so production
  files remain visible when early docs or workflow changes are large.

### Fixed

- Prevent model tool-failure narration, MCP gateway errors, internal reasoning,
  and model-owned delivery footers from being published as public review output.
- Scope sticky tracking comments to the final posting lane so reviewer models
  cannot overwrite each other's public comments.
- Normalize tracking signatures during comment updates so stale lane markers do
  not cause sticky-comment churn after strategy changes.
- Reject internal delivery chatter in MCP tracking and inline-comment handlers
  before it can be buffered or posted.
- Post structured inline finding fallbacks from the host when the model returns
  parseable findings but does not use the inline-comment tool.
- Report unknown and partially known model pricing as unknown or "at least"
  instead of implying an exact zero-cost review.
- Keep valid public review headings such as "Code Health" while still rejecting
  generic internal analysis headings.

### Removed

- Unused legacy spinner assets from the pre-elek branding pass.

## [1.1.2] - 2026-06-13

### Added

- MIT license file and security policy for vulnerability reporting.
- Weekly Dependabot maintenance for GitHub Actions and npm dependencies.
- CI audit gate for high-severity runtime dependency advisories.
- Exact top-level dependency pins for more predictable action installs.
- CodeQL code scanning workflow for JavaScript/TypeScript security analysis.

### Changed

- Hard CI and CodeQL workflows now run on every pull request so branch
  protection can require them without docs-only PRs waiting on skipped checks.
- Self-review workflow concurrency now separates pull request and issue comment
  events so bot tracking comments cannot cancel in-flight PR reviews.
- Composite action runtime installs now omit dev dependencies and avoid
  writing a transient package lockfile.
- Dependabot version-update policy now defers semver-major upgrades to manual
  migration PRs.
- Runtime MCP adapter dependency updated to `pi-mcp-adapter` 2.10.0.

## [1.1.1] - 2026-06-13

### Changed

- Switch the secondary self-review workflow to OpenRouter Kimi K2.7 Code.
- Keep the low-level `tools` input limited to legacy `agent` mode; review
  modes always use their safe mode presets.
- Refresh model examples to current Claude, OpenAI, OpenRouter, and DeepSeek
  review choices, including provider-specific reasoning-effort notes.

### Removed

- Drop the deprecated secondary-provider action input and examples; use
  OpenRouter or another supported provider instead.

### Fixed

- Align generated review prompts with the actual tool surface for `review`,
  `review+edit`, and legacy `agent` modes.
- Avoid telling `review+edit` models to run shell/git commands when MCP is
  disabled but `bash` is still unavailable.
- Warn when `crosscheck` or `council` is configured outside `mode: review`
  instead of silently falling back to solo review.

## [1.1.0] - 2026-06-13

### Added

- Elek branding assets and updated action, package, and README branding.
- `solo`, `crosscheck`, and `council` review strategies for single-model,
  multi-model, and review-council runs.
- Read-only candidate review lenses and final validator synthesis for
  cross-model review flows.

### Changed

- Default generated work branches now use the `elek/` prefix, and contributor
  docs now describe professional branch and PR naming conventions.
- Self-review workflow is advisory while the regular CI workflow remains the
  hard merge gate.
- Action/runtime dependencies moved to the maintained pi package and current
  GitHub Actions runtime packages.

### Fixed

- Inline review posting now validates diff anchors before posting.
- Buffered review comments are grouped into one GitHub review where possible,
  with a fallback issue comment when inline anchors are invalid.
- Advisory self-review prompts now tell models to verify external version
  claims before treating them as findings.

## [1.0.0] - 2026-06-13

### Added

- **Mode system** (`mode` input): `review` (default), `review+edit`, `agent`.
  Each mode picks a tool allowlist and toggles MCP injection. `review` is
  read-only with inline-comment posting; `agent` is the legacy full-bash mode.
- **Review-only MCP server** (`src/mcp/github-review-server.ts`) exposing
  exactly two tools: `create_inline_comment` and `update_tracking_comment`.
  The model can post line-specific review threads but cannot approve, merge,
  or close; that is structural, not a runtime check.
- **Iterate-on-prior-reviews**: `<comments>` block in the prompt now includes
  the bot's own previous reviews. Prompt instructs the model to open with a
  status update for each prior finding before listing new ones.
- **Animated pi-logo spinner** (SVG) for the tracking comment header,
  replacing the previous GIF. Works on fork PRs because the URL points to
  `selimozten/elek@main` rather than `${GITHUB_HEAD_REF}`.
- **CI workflow** (`.github/workflows/ci.yml`): `bun test` + `tsc --noEmit`
  on every PR.
- **AGENTS.md** + **docs/ARCHITECTURE.md** for coding agents and contributors.

### Changed

- Default tools tightened: `read,grep,find,ls,mcp` (was
  `read,write,edit,bash,grep,find,ls`).
- `pi --mode json` is the default; previously fell back to text mode after
  CI hangs were debugged.
- Tracking comment dedup now uses signature only (no bot-login filter), so
  PATs and GitHub Apps reuse the same comment instead of accumulating new
  ones.
- Final review truncation bumped from 4,000 to 60,000 chars (GitHub's
  comment limit is 65,536).

### Fixed

- Pi child-process hang in CI (8-minute zero-output stall before the 30-min
  timeout). Root cause: stdin left open with `stdio: ["pipe", ...]`. Fixed by
  switching to `stdio: ["ignore", ...]`.
- `mcp` proxy tool was filtered by the `--tools` allowlist, leaving the
  model with no path to the MCP server. Now included in `review` and
  `review+edit` modes.
- Race between progress-update and final-review-post overwrote the review
  body. `pi.ts` now `await`s `onProgress({type:"done"})` before resolving.
- `confirmed: false` opt-out was dead in production: handlers wrote the
  buffer entry without the `confirmed` field. Now propagated.
- `pulls.get()` was called even when the model supplied a `commit_id`,
  wasting one API call per inline comment. Now skipped.
- `ensureHeadSha` retried on every entry after a failure, amplifying rate
  limits. Now caches the failure.
- `parseInt` of a non-numeric `trackingCommentId` produced `NaN`. Now
  validated with `Number.isFinite`.
- `package-lock.json` no longer committed (gitignored; composite Action
  installs fresh in CI).
- Type-check (`bunx tsc --noEmit`) passes; previously had latent Octokit
  adapter mismatches.
