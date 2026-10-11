# Final review cleanup report

## Outcome

Addressed the complete final-review disposition in one focused cleanup:

- Replaced the misleading “start a new turn” compatibility advice with actionable guidance to start a new session or add a non-Gemini-3 pool model.
- Added a route-level regression for the all-candidates-filtered error.
- Preserved primitive provider-message rendering for `null`, `false`, and `0`, with explicit coverage.
- Corrected `valueToText` to return `string | undefined`, matching `JSON.stringify(undefined)`, while leaving parsed-JSON extraction behavior unchanged.
- Kept the bounded hard-link fallback and documented its narrow liveness race in code and design.
- Added a deterministic, time-bounded two-process test for exclusion behind a live normal claim.
- Updated the lock-recovery design to describe the implementation accurately.
- Changed the non-reassigned filtered `entries` binding to `const`. Kept `finite` and `num` separate because they have different semantics: `finite` is a type guard, while `num` normalizes invalid input to zero.
- Did not change Gemini current-turn/session routing semantics.

## TDD evidence

### RED

Added the route-level all-candidates-filtered regression before changing production text, then ran:

```text
node --test --test-name-pattern='route: all incompatible candidates' test/wiring.test.ts
```

Result: exit 1, 0 passed / 1 failed. The assertion showed the exact old behavior:

```text
actual:   ... adjust the pool or start a new turn
expected: ... start a new session or add a non-Gemini-3 model to the pool
```

This confirmed the test failed specifically on the misleading compatibility advice.

### GREEN

After the minimal production wording change, primitive characterization assertions, lock test, and documentation cleanup:

```text
node --test --test-name-pattern='route: all incompatible candidates|structured provider error.message|second waiter cannot|orphaned claim|unsupported hard links|replacement lock' test/index.test.ts test/router.test.ts test/wiring.test.ts
```

Result: exit 0, 7 passed / 0 failed.

The lock regression uses explicit filesystem handshakes between two child processes. It holds a normal hard-link claim, observes the second waiter encounter that claim, verifies the original lock token remains and the second update callback has not run, releases the first claimant, and then verifies both updates complete. All waits have fixed deadlines; there is no stress loop or scheduler-dependent success criterion.

## Final verification

```text
npm test
```

Result: exit 0, 72 passed / 0 failed, duration 4683 ms.

```text
npm run typecheck
```

Result: exit 0, `tsc --noEmit` produced no diagnostics.

```text
git diff --check
```

Result: exit 0, no whitespace errors.

## Files changed

- `src/index.ts`
  - Corrected `valueToText` return type.
  - Changed filtered `entries` to `const`.
  - Corrected compatibility recovery advice.
- `src/router.ts`
  - Expanded the fallback comment to state the timed-out-claimant disruption and replacement race, and that token checks constrain the risk.
- `test/wiring.test.ts`
  - Added the all-candidates-filtered route regression.
- `test/index.test.ts`
  - Made preservation of `null`, `false`, and `0` rendering explicit.
- `test/router.test.ts`
  - Added the deterministic live-claim exclusion regression and bounded path-wait helper.
- `docs/superpowers/specs/2026-10-11-review-fixes-design.md`
  - Replaced the inaccurate separate-guard/re-check description with hard-link claims, bounded orphan recovery, unsupported-link fallback, and the narrow fallback race.

## Self-review

- Compatibility wording now matches actual semantics: a new turn retains history, while a new session removes the incompatible history.
- The route test exercises the virtual model route with a credentialed Gemini-only pool; it is not merely a helper-level test.
- `valueToText(undefined)` is represented in the type without introducing a replacement string or changing values obtainable through valid parsed JSON.
- Primitive behavior remains `null` → `"null"`, `false` → `"false"`, and `0` → `"0"`.
- No lock algorithm or timeout was changed. Normal hard-link claim exclusion, bounded orphan cleanup, unsupported-link fallback, owner-token checks, and the selected liveness tradeoff remain intact.
- The design no longer claims a separate recovery guard or post-acquisition guard re-check.
- No Gemini turn/session policy was changed.
- Diff is limited to the six requested code, test, and design files plus this report.

## Remaining concern

The approved fallback necessarily remains non-atomic because Node provides no compare-and-unlink primitive. After the bounded wait, cleanup can briefly disrupt a newer claim, and replacement can occur between the final token read and unlink. Repeated token checks constrain but cannot eliminate that risk; this is the explicitly retained liveness tradeoff.
