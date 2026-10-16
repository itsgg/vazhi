# Done receipts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a vazhi turn settles, reject an unsupported "tests passed" or "created this file" claim once, then mark a repeat unverified.

**Architecture:** `src/done.ts` is a pure check over assistant text and tool receipts. `src/index.ts` records receipts from `tool_result`, resets them on `agent_start`, and on `agent_before_settle` either continues with one note or notifies. The labeled set in `test/done.test.ts` is the evaluation.

**Tech Stack:** TypeScript, node:test, pi coding-agent extension events. No new dependencies.

## Global Constraints

- Node `>=22.19`, as in `package.json`.
- No new runtime dependencies.
- The check runs only for provider `vazhi` and model `auto`.
- One continuation per agent run.
- A pass claim needs a matching command that exited 0 after the last successful write or edit.
- A command containing `|| true`, `|| :`, or `|| exit 0` supports nothing.
- Do not rewrite the assistant message.
- Docs use plain ASCII.

---

### Task 1: Pure check

**Files:**
- Create: `src/done.ts`
- Test: `test/done.test.ts`

**Interfaces:**
- Produces:
  - `Receipt = { kind: "command"; command: string; exitCode: number | null } | { kind: "file"; path: string; ok: boolean }`
  - `unsupportedClaims(text: string, receipts: Receipt[]): string[]` where each string is `test`, `build`, `typecheck`, `lint`, `checks`, or `file:<path>`
  - `doneNote(claims: string[]): string`
  - `settleDone(input: { text: string; receipts: Receipt[]; alreadyPushed: boolean; active: boolean; outcome: "completed" | "aborted" | "error" }): { continue: boolean; note?: string; unverified?: string }`
  - `receiptFromTool(toolName: string, input: Record<string, unknown>, isError: boolean, structured: unknown): Receipt | null`

- [x] **Step 1: Write `test/done.test.ts`** covering no receipt, exit 0, test-before-edit, failed exit, negation, hedge, file suffix, `|| true`, settle once, and the labeled tally.

- [x] **Step 2: Run `node --test test/done.test.ts`** and confirm it fails because the module is missing.

- [x] **Step 3: Implement `src/done.ts`** to the spec in `docs/superpowers/specs/2026-10-16-done-receipts-design.md`.

- [x] **Step 4: Re-run `node --test test/done.test.ts`** and confirm the tally has zero misses and zero false alarms.

### Task 2: Wire it into the extension

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`

- [x] **Step 1: On `agent_start`, clear receipts and the one-shot flag.**

- [x] **Step 2: On `tool_result`, while `vazhi/auto` is selected, append `receiptFromTool` when it returns a receipt.**

- [x] **Step 3: On `agent_before_settle`, read the last assistant text from `event.context.contextMessages`. Call `settleDone`. When `continue` is set, return `{ continue: true, entries: [{ type: "custom_message", customType: "vazhi-done", content: note, display: true }] }` and remember that this run already pushed. When `unverified` is set and the UI exists, notify `vazhi: unverified: ...`.**

- [x] **Step 4: Document the behavior in the "How it works" section of `README.md`.**

- [x] **Step 5: Run `npm test` and `npm run typecheck`.**
