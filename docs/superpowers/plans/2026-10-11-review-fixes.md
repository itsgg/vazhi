# Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four reviewed correctness defects with regression coverage and no new runtime dependencies.

**Architecture:** Keep the existing router, pool, and store boundaries. Make signature compatibility explicit with a discriminated union, normalize untrusted error and state data at their boundaries, and make lock deletion operate on an atomically hard-linked snapshot so stale-lock observers cannot delete a replacement lock.

**Tech Stack:** TypeScript 7, Node.js 22.19+ built-in test runner and filesystem APIs.

## Global Constraints

- Add no runtime dependency.
- Preserve normal model ordering, cooldown behavior, and package contents.
- Write and observe each regression test failing before changing production code.

---

### Task 1: Make Gemini signature compatibility explicit

**Files:**
- Modify: `test/router.test.ts`
- Modify: `test/wiring.test.ts`
- Modify: `src/router.ts:103-153`
- Modify: `src/index.ts:221-235`

**Interfaces:**
- Produces: `SignatureConstraint`, a union with `mode: "unrestricted" | "blocked" | "pinned"`.
- Produces: `signatureConstraint(messages): SignatureConstraint`.

- [ ] **Step 1: Update helper tests and add route-level regressions**

Assert that no tool calls return `{ mode: "unrestricted" }`, incompatible calls return `{ mode: "blocked" }`, and a valid single signer returns `{ mode: "pinned", model }`. In `test/wiring.test.ts`, supply a registry containing a Google Gemini 3 model before a non-Gemini model and verify an incompatible conversation selects the non-Gemini model. Also verify a signed conversation may select only its exact Gemini model.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/router.test.ts test/wiring.test.ts`

Expected: helper assertions fail because the current function returns strings or `undefined`; the route-level blocked case selects Gemini.

- [ ] **Step 3: Implement the discriminated constraint and unconditional filtering**

Return:

```ts
export type SignatureConstraint =
	| { mode: "unrestricted" }
	| { mode: "blocked" }
	| { mode: "pinned"; model: string };
```

In routing, leave non-Gemini models eligible, remove every Gemini 3 model for `blocked`, and retain only the exact signed Gemini model for `pinned`. Throw a descriptive compatibility error if filtering leaves no candidates.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/router.test.ts test/wiring.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/index.ts test/router.test.ts test/wiring.test.ts
git commit -m "Fix Gemini signature routing constraints"
```

### Task 2: Normalize structured provider errors

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/index.ts:49-91`

**Interfaces:**
- Preserves: `summarizeError(raw: string, key: string): string`.

- [ ] **Step 1: Add malformed-shape regression tests**

Call `summarizeError()` with object-valued, numeric, and null `error.message` fields. Assert each returns a one-line string containing the key and a stable representation rather than throwing.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/index.test.ts`

Expected: the object-valued case fails with `TypeError: text.replace is not a function`.

- [ ] **Step 3: Add a local value-to-text boundary helper**

Accept strings directly, JSON-stringify structured and primitive JSON values, and fall back to the original raw response when no message exists. Preserve the existing nested JSON-message extraction and HTTP status prefix.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/index.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "Harden provider error summaries"
```

### Task 3: Validate persisted state recursively

**Files:**
- Modify: `test/router.test.ts`
- Modify: `src/router.ts:92-101`
- Modify: `src/router.ts:181-195`

**Interfaces:**
- Preserves: `Store.load(): State`.
- Adds private normalization helpers for cooldowns, provider-limit records, dispatch arrays, and slow timestamps.

- [ ] **Step 1: Add a mixed valid/corrupt state regression**

Write a valid JSON state containing valid entries beside malformed nested entries such as a numeric dispatch value, non-finite-compatible strings, missing cooldown fields, and invalid slow markers. Assert valid entries survive, invalid entries are absent, and `choose()`, `reserve()`, and `coolingReason()` do not throw.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/router.test.ts`

Expected: routing reaches `.filter()` on a non-array dispatch value and throws.

- [ ] **Step 3: Normalize nested state during load**

Build fresh records with `Object.fromEntries()`. Keep only finite numeric timestamps, well-formed cooldown objects, valid `{ at, model }` provider-limit records, and arrays filtered to finite numbers.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/router.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router.test.ts
git commit -m "Validate persisted router state"
```

### Task 4: Make stale-lock deletion ownership-safe

**Files:**
- Modify: `test/router.test.ts`
- Modify: `src/router.ts:5`
- Modify: `src/router.ts:164-235`

**Interfaces:**
- Preserves: `Store.update<T>(change): T`.
- Adds: a private claim path `${stateFile}.lock.claim`.
- Uses: `linkSync(lock, claim)` to atomically snapshot the lock inode before inspecting or deleting it.

- [ ] **Step 1: Add a deterministic replacement-race regression**

Patch `fs.statSync` for a fresh dynamic import of `src/router.ts`. When stale inspection occurs, replace the stale lock with a fresh owner token and return the stale stat. A child process confirms that the fresh token remains until it deliberately releases it. Assert `Store.update()` waits and then completes. Restore the built-in filesystem export in `finally`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/router.test.ts`

Expected: the child reports that the current implementation deleted its fresh replacement lock.

- [ ] **Step 3: Implement hard-link claims for every deletion**

Before stale cleanup or normal release, atomically hard-link the current lock to the claim path. While holding that unique claim:

1. inspect the claim file, not the mutable lock path;
2. compare the claim token with the current lock token;
3. delete the lock only when the tokens match and the release/staleness condition is true;
4. always remove the claim path.

If another process owns the claim, wait and retry. A newly created lock has a different token and therefore cannot be deleted by a stale observer.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/router.test.ts`

Expected: the replacement survives, all atomic-update tests pass, and no lock/claim file remains.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router.test.ts
git commit -m "Make stale lock recovery ownership-safe"
```

### Task 5: Full verification

**Files:**
- Verify only.

- [ ] **Step 1: Run tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: every test passes and TypeScript reports no errors.

- [ ] **Step 2: Check dependency and package output**

Run:

```bash
npm audit --omit=dev
npm pack --dry-run
```

Expected: zero production vulnerabilities; package contents include runtime sources, README, license, and pool only.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check HEAD~4..HEAD
git status --short --branch
```

Expected: no whitespace errors and no uncommitted implementation changes.
