# Evidence-Grounded Vazhi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vazhi's free-model routing easier to understand and less likely to end with unsupported claims, while measuring every behavior-changing intervention against the real full-pool router.

**Architecture:** Keep `src/index.ts` as extension wiring. Move pure provider-error normalization, model availability, command rendering, observation windowing, and receipt verification into focused modules with direct unit tests. Replace the current isolated-model quality multiplier with a full-pool harness that supports hidden tests and paired control/treatment trials.

**Tech Stack:** TypeScript 7, Node's test runner, pi 1.1 extension APIs, Python 3 standard library, GitHub Actions.

## Global Constraints

- Free means that the downloaded pool cannot select a paid model by construction.
- One model owns a tool loop; API failure may reroute, but per-step model switching is not a default.
- No model judges, LLM-generated summaries, or unsupported performance claims.
- Public smoke tasks validate the harness only; user-impact claims require a private paired task bank.
- Timeout, crash, and no-answer are failures in quality evaluation, not skipped rows.
- Every behavior change follows a red-green test cycle.
- Experimental policies default off until their paired 95% interval is above zero and false success does not rise.

---

### Task 1: Release and free-model pool

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/publish.yml`
- Modify: `src/providers.ts`
- Modify: `scripts/discover.ts`
- Modify: `data/static.json`
- Modify: `pool.json`
- Test: `test/providers.test.ts`
- Test: `test/discover.test.ts`
- Test: `test/committed.test.ts`

- [ ] Keep version `0.1.2` in package metadata.
- [ ] Admit only explicitly free Cloudflare model IDs.
- [ ] Keep paid and unknown Cloudflare models out of remote pools.
- [ ] Treat npm's exact already-published-version error as a successful no-op while preserving every other failure.
- [ ] Run the focused provider, discovery, and committed-artifact tests.

### Task 2: Provider-error normalization

**Files:**
- Create: `src/errors.ts`
- Modify: `src/index.ts`
- Create: `test/errors.test.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Produces: `normalizeFailure(raw: string, provider?: string): FailureSummary`
- Produces: `formatFailure(summary: FailureSummary): string`
- Produces: `FailureSummary` with `kind`, optional HTTP status, concise message, optional retry delay, and failure scope.

- [ ] Write failing fixtures for plain text, nested OpenAI/Google JSON, malformed JSON, non-string messages, identifiers, and retry delays.
- [ ] Verify the tests fail against the current `summarizeError`.
- [ ] Implement recursive bounded extraction, whitespace cleanup, redaction, classification, and concise formatting.
- [ ] Use the normalized failure for cooldown storage, retry messages, and status display.
- [ ] Run focused error and router tests.

### Task 3: Shared model availability

**Files:**
- Create: `src/models.ts`
- Modify: `src/index.ts`
- Modify: `src/router.ts`
- Create: `test/models.test.ts`

**Interfaces:**
- Produces: `availability(entry, state, registry, now, constraint): ModelAvailability`
- `ModelAvailability` distinguishes ready, slow, cooling, missing key, missing catalogue entry, and incompatible history.

- [ ] Write failing tests for each availability state and shared-provider cooldown.
- [ ] Implement one pure availability decision used by routing and `/vazhi`.
- [ ] Keep provider-specific exceptions limited to Gemini signatures and NVIDIA request headers.
- [ ] Run model, router, and wiring tests.

### Task 4: `/vazhi` status and help

**Files:**
- Create: `src/status.ts`
- Modify: `src/index.ts`
- Create: `test/status.test.ts`
- Modify: `test/wiring.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `renderStatus(input): string`
- Produces: `renderHelp(): string`
- Commands: `/vazhi`, `/vazhi status`, `/vazhi all`, `/vazhi help`, `/vazhi update`, `/vazhi reset`.

- [ ] Write failing output tests with ready, slow, cooling, missing-key, and missing-catalogue models.
- [ ] Group status by actionable state, collapse missing keys by provider, retain pool rank, and put bounded failure details on an indented line.
- [ ] Add command completions and concise unknown-command help.
- [ ] Verify no raw provider JSON or secrets appear.
- [ ] Run status and wiring tests.

### Task 5: Correct the ranking signal

**Files:**
- Modify: `scripts/rank.ts`
- Modify: `test/rank.test.ts`
- Modify: `README.md`

- [ ] Write a failing test proving tiny or missing eval records cannot change rank.
- [ ] Remove the three-task eval multiplier.
- [ ] Keep quality, capacity, availability history, and deterministic tie-breaking.
- [ ] Update the pool-building documentation.
- [ ] Run rank and committed-artifact tests.

### Task 6: Full-pool hidden-test evaluation

**Files:**
- Rewrite: `scripts/eval.py`
- Create: `scripts/eval_stats.py`
- Create: `test/test_eval.py`
- Create: `test/test_eval_stats.py`
- Modify: `.github/workflows/eval.yml`

**Interfaces:**
- Task manifests come from `--tasks-dir`.
- Hidden checks live outside the agent workspace.
- Every result records control/treatment arm, router SHA, pool SHA, task-bank hash, seed, model attempts, duration, requests, hidden pass, false success, and collateral changes.

- [ ] Write failing tests for task discovery, workspace isolation, timeout/no-answer failure, metadata hashes, and schema validation.
- [ ] Implement public smoke mode that makes no quality claim.
- [ ] Implement private task-bank input without committing private fixtures.
- [ ] Write failing paired-statistics tests for randomized order, pass-at-1, pass-at-3, paired effect, confidence interval, and false-success guardrail.
- [ ] Implement paired summaries using only the Python standard library.
- [ ] Make weekly CI upload diagnostics instead of committing a ranking input.
- [ ] Run all Python tests and a local synthetic smoke.

### Task 7: Durable execution receipts

**Files:**
- Modify: `src/done.ts`
- Modify: `src/index.ts`
- Modify: `test/done.test.ts`
- Modify: `test/wiring.test.ts`

- [ ] Write failing tests for successful mutating shell commands after a green check.
- [ ] Recognize redirects, `tee`, `sed -i`, `perl -i`, `patch`, `git apply`, `rm`, `mv`, `cp`, and `truncate` as mutations without blocking them.
- [ ] Extend forced-success detection to trailing success forms while avoiding valid shell conditionals.
- [ ] Write failing tests for read, edit, then whole-file write.
- [ ] Expire read authorization after a later path mutation; conservatively expire reads after an unlocated shell mutation.
- [ ] Write failing tests for a modified test file followed by a green test.
- [ ] Add a durable caveat rather than rejecting the pass.
- [ ] Write a wiring test proving a repeated unsupported claim appends a history entry without another continuation.
- [ ] Preserve one correction continuation and no model judge.
- [ ] Run done and wiring tests.

### Task 8: Deterministic observation windowing

**Files:**
- Create: `src/observations.ts`
- Modify: `src/index.ts`
- Modify: `src/pool.ts`
- Create: `test/observations.test.ts`
- Modify: `test/wiring.test.ts`

**Interfaces:**
- Produces: `windowObservations(messages, options): messages`
- Configuration: experimental opt-in, latest-observation count, and line budget.

- [ ] Write failing tests that preserve user requirements, the latest five observations, error tails, exit codes, images, and stored session history.
- [ ] Collapse older results deterministically to tool, path/command, outcome, and omitted-line count.
- [ ] Cap broad search output and instruct the model to narrow its query.
- [ ] Do not use model-generated summaries.
- [ ] Wire the pure transform into the provider-facing `context` event behind an opt-in switch.
- [ ] Run observation and wiring tests.

### Task 9: Experimental policy radar

**Files:**
- Create: `docs/task-radar.md`
- Modify: `scripts/eval.py`
- Modify: `scripts/eval_stats.py`
- Modify: `src/pool.ts`
- Test: `test/test_eval.py`
- Test: `test/pool.test.ts`

- [ ] Record every active, experimental, waiting-for-data, and closed idea with source, hypothesis, arm, metric, decision rule, result, and next review date.
- [ ] Add experiment identifiers for observation windowing, strict stickiness, clean retry after a failed executable check, task-class ranking, and a bounded repository map.
- [ ] Add configuration/schema slots only; do not add unmeasured runtime behavior for experiments other than windowing.
- [ ] Define reopening evidence for closed items: neural routing, weak-first cascades, per-step switching, planners, general subagents, model judges, broad completion lexicons, LLM summaries, generated tests, reflection-only retries, JSON replies, full Viveka runtime, mandatory reads before exact edit, and SWE-bench Verified gating.
- [ ] Validate experiment IDs and frozen metadata in evaluation tests.

### Task 10: Documentation and self-review

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-16-done-receipts-design.md`
- Modify: `docs/superpowers/plans/2026-10-16-done-receipts.md`
- Modify: `docs/task-radar.md`

- [ ] Document commands, statuses, configuration, receipt caveats, windowing opt-in, evaluation limits, and Cloudflare setup.
- [ ] Cite the web evidence that justifies each experimental or closed radar row.
- [ ] Remove claims that the old three-task evaluation adjusts model quality reliably.
- [ ] Check the plan for uncovered requirements, placeholders, and inconsistent interfaces.

### Task 11: Verification, review, and shipping

**Files:**
- Review all changed files.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run the Python evaluation tests.
- [ ] Run a local synthetic full-pool smoke without provider secrets.
- [ ] Inspect the complete staged and unstaged diff.
- [ ] Scan the staged diff with `betterleaks`.
- [ ] Run a read-only Codex review asking for concrete correctness, safety, compatibility, and evaluation-integrity findings with file and line.
- [ ] Reproduce every finding; fix valid findings with a red-green regression test and record rejected findings with evidence.
- [ ] Rerun all gates and the secret scan.
- [ ] Commit with the reviewer and finding dispositions in the message, without generated or co-author trailers.
- [ ] Push as a separate command.
- [ ] Open a pull request documenting behavior, evidence, evaluation limitations, rollout, and rollback.
