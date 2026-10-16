# Vazhi task radar

This is the backlog for evidence-grounded changes to vazhi. Nothing disappears because it is not ready to become a default.

## Decision rule

A runtime intervention becomes a default only when a paired full-pool private evaluation finds a positive hidden-test effect whose 95% interval is entirely above zero, with no increase in false success and acceptable request and latency costs. Public smoke tasks validate mechanics only.

| State | Task | Evidence and reason | Next evidence |
|---|---|---|---|
| Built | Normalize provider errors | Nested provider JSON is reduced to one status, kind, and short message before display or cooldown text. | Provider fixtures in `test/errors.test.ts`. |
| Built | Share model availability between routing and status | `/vazhi` and the router use `modelAvailability`. | `test/models.test.ts` and the command wiring test. |
| Built | Redesign `/vazhi` and add help | Status is grouped. `/vazhi help` and `/vazhi all` are available. | `test/status.test.ts`. |
| Built | Replace the isolated-model weekly score | Rank ignores the three-task multiplier. Weekly CI checks the public bank and does not commit a score. | `test/rank.test.ts`, `test/test_eval.py`. |
| Built | Harden execution receipts | A repeated unsupported claim is stored in the session. Shell mutations, stale reads, and edited tests are covered. | `test/done.test.ts` and the settle wiring test. |
| Built, default off | Deterministic observation windowing | The transform keeps five recent results and collapses older ones without a model. `experiments.observations` enables it. | Paired private trial before the default changes. |
| Experiment | Strict per-turn stickiness | Later handoff did not establish a utility gain over initial selection on BFCL or MultiWOZ and increased BFCL cost. | Compare current slow-model switch with strict stickiness. |
| Experiment | Clean retry after a failed executable check | Retry contamination models predict a benefit, but fresh starts remain correlated by task difficulty. | Paired trial only on tasks with a failed local check. |
| Waiting for labels | Task-class model table | Simple task-type selection can beat learned routing, but vazhi has no held-out per-class outcomes. | Populate only after enough private task outcomes exist. |
| Waiting for labels | Bounded repository signature map | RepoGraph added about two points for GPT-4o; smaller models used added context less effectively. | Test a capped pre-read map after windowing is measured. |
| Closed | Neural router | Learned routers require held-out model-task labels; vazhi's three public tasks cannot train or validate one. | Reopen with a sufficiently large held-out outcome matrix. |
| Closed | Weak-first cascade | Published value is paid-model cost reduction. In vazhi it consumes scarce free quota before the strongest free model. | Reopen if a measured quota-aware arm beats strongest-first. |
| Closed | Per-step model switching | Measured handoff work does not establish a benefit over initial selection, while tool history and thought signatures make switching risky. | Reopen with a live coding-agent result on compatible models. |
| Closed | Planner or todo ritual | Explicit planning produced only small gains and was insufficient alone; the extra request is material on free tiers. | Reopen with a controlled gain on comparable free coding models. |
| Closed | General subagents | Generic subagents hurt ProgramBench; task-specific ones helped strong models but increased tool calls by 73–116%. | Reopen with a bounded specialist and quota-adjusted gain. |
| Closed | Second-model judge | False-success judges reached at most 0.65 AUROC on tau2-bench and 0.54 on AppWorld traces. | Reopen only if it beats host receipts at equal false-positive rate. |
| Closed | Broad completion-word detector | Words such as “done” and “successfully” are surface proxies that also occur in honest coding replies. | Reopen with repository-session precision and recall. |
| Closed | LLM context summary | A measured compressor removed requirements and debugging state and reduced scores despite large token savings. | Reopen with a paired gain that preserves user requirements. |
| Closed | Generated tests or multi-sample selection | Reported gains require many generations or have low recall, which exceeds free-tier budgets. | Reopen with a bounded one-call verifier and hidden-test gain. |
| Closed | Reflection without a new observation | Useful correction loops add an executable error; self-reflection alone supplies no new state. | Reopen with a controlled tool-agent ablation. |
| Closed | JSON-wrapped assistant replies | Output constraints can reduce reasoning quality; pi already constrains tool arguments at the narrow boundary. | Reopen only for an API consumer that requires it. |
| Closed | Full Viveka runtime | A coding turn's checkable claims are commands and paths; claim graphs and signed mandates add a second runtime without closing the known holes. | Reopen for non-executable claim types not covered by receipts. |
| Closed | Mandatory full read before exact-match edit | Pi's edit fails closed; whole-file context reduced SWE-agent performance compared with a bounded view. | Reopen if edit corruption survives exact matching. |
| Closed | SWE-bench Verified as a release gate | OpenAI found material problems in 59.4% of audited hard cases and evidence of contamination. | Keep only a pinned external anchor; use private tasks for decisions. |

## Sources

- False success and judge limits: https://arxiv.org/abs/2606.09863
- SWE-agent interface ablations: https://arxiv.org/abs/2405.15793
- Harness, compression, planning, and subagent ablations: https://arxiv.org/abs/2609.32459
- Multi-turn handoff curves: https://arxiv.org/abs/2610.15993
- RouteLLM: https://arxiv.org/abs/2406.18665
- Agentless: https://arxiv.org/abs/2407.01489
- RepoGraph: https://arxiv.org/abs/2410.14684
- Retry contamination model: https://arxiv.org/abs/2605.08563
- OpenAI SWE-bench Verified audit: https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
