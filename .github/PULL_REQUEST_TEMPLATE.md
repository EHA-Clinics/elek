<!--
Thanks for the PR. The advisory AI review council will run automatically.
A few quick checks before you submit:
-->

## What changed

<!-- One paragraph: what does this PR do, and why? -->

## How this was tested

- [ ] `bun test test/` passes
- [ ] `npm run typecheck` clean
- [ ] `npm audit --omit=dev --audit-level=high` passes
- [ ] Action input declaration, exact `INPUT_*` mapping, parser, types, tests, and docs agree
- [ ] Immutable live-canary evidence (caller PR head, action/workflow SHAs, run/artifact links) supplied; for an inert action release, link the rollout plan that requires caller canaries before adoption

## Risk

<!-- Anything load-bearing? Any irreversible / hard-to-revert behavior? -->

## Out of scope

<!-- Anything you noticed but explicitly didn't fix here? -->

---

<!--
Please don't:
- Add new MCP tools beyond the two existing ones (safety story)
- Import a model-specific SDK (model-agnostic story)
- Add bash to default modes (jailbreak surface)

If your change touches any of those, file an issue first to discuss.
-->
