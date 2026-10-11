# Review Fixes Design

## Goal

Fix the four correctness issues found in the repository review without adding runtime dependencies or changing normal routing behavior.

## Routing constraints

Replace the ambiguous `string | undefined` signature constraint with a discriminated result:

- `unrestricted` when the conversation contains no tool calls that restrict Gemini 3.
- `blocked` when no Gemini 3 model can safely replay the conversation.
- `pinned` with a model key when only one Gemini 3 model is compatible.

The route filters Gemini 3 candidates for both `blocked` and `pinned` results. Non-Gemini candidates remain eligible in every case. Tests exercise the virtual model route, not only the constraint helper.

## Error normalization

Provider error JSON is untrusted. Error-summary extraction will convert supported primitive values to text and serialize structured values before applying string replacements. It will fall back to the original error text if serialization fails. The message-end handler must never throw because a provider returned a non-string `message`.

## Persisted-state validation

`Store.load()` will normalize every nested collection:

- cooldowns require finite `until`, `failures`, and `at` values plus a string `reason`;
- provider limit records require a finite `at` and string `model`;
- dispatch history keeps only finite timestamps from arrays;
- slow markers keep only finite timestamps.

Invalid entries are dropped independently so one damaged value does not discard otherwise valid state.

## Lock recovery

Keep exclusive `wx` lock-file creation. Lock deletion first hard-links the main lock to a fixed claim path, so only one cooperating process can inspect and remove that lock snapshot at a time. The claimant checks the claim's token or age and removes the main lock only while its token still matches the claimed snapshot.

A killed claimant can leave the claim path behind. Waiters therefore bound how long they honor a busy claim before cleaning it up and using a token-checked fallback; filesystems that do not support hard links use the same fallback immediately. Node has no compare-and-unlink operation, so this liveness fallback retains a narrow race: a timed-out claimant's cleanup may briefly disrupt a newer claim, and replacement may occur between the final token read and unlink. Repeated token checks constrain that risk. The lock owner token remains authoritative during normal release.

## Testing

Follow red-green cycles for:

1. route-level blocking and pinning of Gemini 3 models;
2. structured, numeric, and null provider error messages;
3. malformed nested state values mixed with valid state;
4. deterministic lock replacement during stale recovery and exclusion behind a live normal claim.

Then run the complete test suite, TypeScript typecheck, production dependency audit, package dry-run, and repository cleanliness checks.
