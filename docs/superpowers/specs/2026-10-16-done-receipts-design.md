# Done receipts

## Goal

Stop a free model from ending a vazhi turn by claiming work it did not record. The check is deterministic. It reads tool results pi already stored. It does not call another model, and it does not depend on the model obeying a prompt.

This is Viveka's rule that a run is done only when a receipt says so, narrowed to the claims a coding agent uses to declare success.

## What is checked

Only while `vazhi/auto` is the selected model, and only when the agent run is about to settle as `completed`.

The final assistant text is split into sentences. A sentence is ignored when it is hedged (`if`, `should`, `might`, `may`, `would`, `could`, `unless`, `until`, `hopefully`, `assuming`) or negated (`not`, `never`, `cannot`, `unable`, `didn't`, `don't`, `without`), except for the explicit forms below.

These claims are recognized:

- Tests passed, including "no tests failed" and "tests are green".
- The build passed or is clean.
- Typecheck passed, including "no type errors".
- Lint passed, is clean, or "no lint errors".
- Checks passed.
- A file was created, written, or added, when the sentence names a path with an extension.

Anything else, including "I fixed the bug" with no pass or file claim, is left alone.

## What supports a claim

Receipts are the successful and failed tool results of the current agent run, in order. A new user prompt starts a new run and clears them.

A command receipt stores the command string and its exit code. pi's bash and PowerShell tools put the code in `structuredContent.exit_code`. A non-zero code is an error result. When that field is missing, an error result has no exit code, and a non-error result counts as exit 0.

A file receipt stores the path of a write or edit and whether the tool errored.

A pass claim is supported only when a matching command exited 0 after the last successful write or edit in the run. A test command before an edit does not support "tests pass". These commands match:

- test: `npm`/`pnpm`/`yarn`/`bun` `test` or `run test`, `npx vitest`/`jest`, `pytest`, `vitest`, `jest`, `cargo test`, `go test`, `mix test`, `phpunit`, `rspec`, `ctest`, `mvn test`, `gradle test`, `dotnet test`
- build: `npm`/`pnpm`/`yarn`/`bun` `run build`, `cargo build`, `go build`, `mvn package`, `gradle build`
- typecheck: `tsc`, `npm`/`pnpm`/`yarn`/`bun` `run typecheck`, `mypy`, `pyright`, `vue-tsc`
- lint: `eslint`, `ruff`, `biome`, `npm`/`pnpm`/`yarn`/`bun` `run lint`, `cargo clippy`

"Checks passed" is supported when any one of those four succeeded after the last edit.

A command that contains `|| true`, `|| :`, or `|| exit 0` supports nothing. Forcing a zero exit is not a receipt of success.

A file claim is supported when a successful write or edit path equals the claimed path, or the claimed path is a directory-boundary suffix of it (`src/a.ts` matches `/repo/src/a.ts`, and does not match `not-src/a.ts`).

## What happens

The first time the settling reply has an unsupported claim, vazhi appends one user-visible message and continues the run. The message names each claim and tells the model to run the check after the last edit, or to delete the claim, and not to say it passed unless a matching command exited 0.

The same run gets one continuation. If the reply still has an unsupported claim, the run ends and the UI shows `vazhi: unverified:` plus the claims. The assistant text is not rewritten.

Aborted and error outcomes are not checked. Turns that are not `vazhi/auto` are not checked.

## Overwrite

`write` replaces a whole file, and pi does that whether or not the model has seen the file. vazhi blocks a write whose target already exists unless this run has a successful read of that path. A new file is allowed. An edit is not blocked here: its old text has to match the file, so a guess fails closed. A shell redirect can still replace a file; vazhi does not parse shell commands.

## Limits

The check does not know whether a command's output is honest, only its exit code. It does not judge code quality. A path without an extension is not a file claim. "I fixed it" alone is not a claim. A basename such as `a.ts` can match another `a.ts` in a different directory.

## Evaluation

A labeled set of replies and receipts is the measurement. Every reply marked false must produce at least one unsupported claim. Every reply marked honest must produce none. The test reports how many of each it saw. No live model call is part of this check: the decision does not depend on a model.

## What further research changes

Two sources argue against widening this check.

Advani, "From Confident Closing to Silent Failure" (arXiv:2606.09863, 1 Jun 2026), labels false success as a completion claim that the environment state does not support. On tau2-bench, 45–48% of failures in single-control domains are false success, and 3% where an independent party can verify state. Among AppWorld coding-agent trajectories that write an explicit status, 75.8% of failures are false success. No LLM judge in that study exceeds AUROC 0.65, because judges treat confident closing language as success. The paper's deployment note is that higher-stakes checks have to compare the trajectory with the environment, and that a surface-text detector at a 10% flag rate is only 50% precise. Their completion regex (`successfully`, `has been`, `all set`, refunds) is for customer-service closings. Copying it into vazhi would flag ordinary coding replies.

A 424-run coding-agent study (dev.to, Ta Nguyen, summarized at explore.n1n.ai on 5 Sep 2026) forced models to paste the command, exit code, and output before saying they were done. Evidence in the reply rose from 0 of 99 to 84 of 87. On the hidden-test tier, false success stayed 75.0% against a 73.6% baseline. The agent had run the visible tests, those tests exited 0, and the hidden tests still failed.

So the check stays a comparison against pi's tool results. A second model, or a longer list of words like "successfully" and "done", is the approach those measurements found does not move the failure. The remaining hole is a command that really exited 0 on the tests the model chose to run. vazhi cannot see tests that were never executed.
