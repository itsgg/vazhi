# vazhi

vazhi (Tamil for "way") is a free LLM auto-router for the [pi coding agent](https://pi.dev). Select the model `vazhi/auto` and every request goes to the best free model that is up right now. When a provider rate-limits, runs out of quota, hangs or fails, vazhi moves the request to the next model in the same turn, and every pi session on the machine skips that provider until it recovers.

The model list is rebuilt every night by CI: it reads the free catalogs, sends every candidate a real tool-calling request, and ranks what answers. Installed copies pick up the new list within a day, with no reinstall.

## Install

```bash
pi install npm:vazhi
```

Or straight from GitHub: `pi install git:github.com/itsgg/vazhi`.

Then make `vazhi/auto` the default and give pi enough retries to walk the pool, in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "vazhi",
  "defaultModel": "auto",
  "httpIdleTimeoutMs": 45000,
  "retry": { "enabled": true, "maxRetries": 20, "baseDelayMs": 300, "maxAgentDelayMs": 4000 }
}
```

Each retry is a new model, so pi's default of 3 retries with a 2-second backoff would give up after four models. The 45-second idle timeout moves on from a provider that hangs instead of waiting five minutes. Models already known to be cooling are skipped without using a retry.

It works with no keys at all, through Kilo's free gateway, OVHcloud's anonymous tier and LLM7. Each free key you add widens the pool. Add them inside pi with `/login <provider>`:

| Provider | Key from | Adds |
|---|---|---|
| `nvidia` | build.nvidia.com | GLM 5.3 Flash, Nemotron 3 Ultra, DeepSeek V4.1 Flash and more, up to 40 requests a minute |
| `google` | aistudio.google.com/app/apikey | Gemini Flash (about 20 requests a day) and Flash-Lite |
| `openrouter` | openrouter.ai/keys | 50 free requests a day across its `:free` models |
| `ollama-cloud` | ollama.com/settings/keys | a small monthly credit for its starter models |
| `zai-free` | z.ai | GLM 4.7 Flash, no daily cap |

Use keys from free plans. vazhi only routes to free tiers, but a key on a paid plan is billed by its provider: a Google key whose project has billing enabled, for example.

## How a request is routed

The pool is an ordered list. For each request vazhi takes the first model that has a key (or needs none) and is not cooling down. Within one turn it stays on the model already doing the work, so tool calls and their results stay with one model.

When a model fails, it cools down for as long as the provider asks (`Retry-After`, "try again in 7m12s"), or by the kind of failure: 30 seconds and up for a rate limit, an hour for a daily quota or a removed model, 15 minutes for a hang, 6 hours for a rejected key. A repeat failure doubles the cooldown. A success clears it. Cooldowns live in one state file shared by every pi process, under a lock.

Waiting is kept short three ways. NVIDIA's free tier queues a request it cannot serve for up to an hour, because pi asks it to; while vazhi routes, it asks for 5 seconds instead, so a dead NVIDIA model answers 504 in about 7 seconds and the request moves on (a working model is not cut off: one that took 59 seconds to its first token still answered). A model that takes more than 15 seconds to its first token goes behind faster models for 10 minutes, though it still serves when nothing faster is ready. And pi's "Working" line names the model being asked, so a wait is never a mystery.

pi retries rate limits and server errors by itself, and on each retry vazhi picks another model. pi does not retry quota, 404 or bad-key errors, so vazhi marks those as retryable and pi moves on. When every model is cooling, vazhi waits up to 65 seconds for the first one back, then stops with a message naming it.

`/vazhi` shows the pool with each model's state, `/vazhi reset` clears all cooldowns and `/vazhi update` fetches the nightly pool now.

## How updates arrive

The model list updates itself. CI commits a new `pool.json` whenever tonight's probes change it, and vazhi checks its downloaded copy at the start of every session and every turn: once the copy is 12 hours old it fetches the new one in the background, or an hour after a failed try. New models for vazhi's own providers appear at once; models of pi's built-in providers also need pi to know them, which pi handles by refreshing its catalog from pi.dev every 4 hours. `/vazhi update` fetches now.

Code changes, a fix to the router or a new provider, arrive with `pi update --extensions`.

## How the pool is built

`.github/workflows/nightly.yml` runs `scripts/discover.ts` every night:

1. Candidates are free chat models with tool calling, from the public catalogs of Kilo, OVHcloud, LLM7, NVIDIA NIM and OpenRouter, plus Gemini Flash. For pi's built-in providers only models in pi's catalog qualify, since vazhi routes through pi's model registry; CI reads the same live catalog pi downloads from pi.dev, so a model pi learns about today is a candidate tonight.
2. Each candidate gets one tool-calling request where CI can reach it. A pass marks it up; two failures in a row, or a failure with no pass before it, mark it down. A rate limit decides nothing, since CI shares IP addresses with others.
3. The score is quality x capacity x eval. Quality is the [Artificial Analysis](https://artificialanalysis.ai/) coding index where AA covers the model, else a manual seed in `data/seed-scores.json`. Capacity is how much free use the provider gives (`scripts/rank.ts`). Eval is the weekly pi eval below. Models that are down go last.

`.github/workflows/eval.yml` runs three small coding tasks through pi and vazhi each week on the top ten models: a bug fix against unit tests, a refactor across four files, and a log search with a decoy. Pass rates feed the score, which catches models that benchmark well but stumble in a real agent loop.

`data/exclude.json` lists models that are never used, with the reason: Gemini models Google silently routes to others, and Gemma 4 on the Gemini API, whose 16K tokens a minute is smaller than one pi request.

## Configuration

`~/.pi/agent/vazhi/config.json`, all fields optional:

```json
{
  "exclude": ["llm7", "google/gemini-3.6-flash"],
  "prefer": ["nvidia/nvidia/nemotron-3-ultra-550b-a55b"],
  "autoUpdate": true
}
```

`exclude` drops models or whole providers. `prefer` moves models to the front, in order. `pool` replaces the list entirely, with `{ "model": "provider/id", "rpm": 2 }` entries. `autoUpdate: false` stops the nightly download.

## What the downloaded pool can do

The nightly pool can only name models, never endpoints or keys: base URLs live in `src/providers.ts`. Each provider also has a rule in code for which models the downloaded pool may use, and each rule admits only models that are free by that provider's terms: `:free` models on Kilo and OpenRouter, Flash and Flash-Lite on Gemini, NVIDIA's free trial catalog, fixed lists for Ollama, Z.ai and Cloudflare, and anything on OVH and LLM7, where vazhi sends no key. So a compromised pool file cannot send your prompts or keys anywhere new, or route you to a paid model. Two limits: a Google key whose project has billing enabled is billed for Gemini Flash like any paid key, and a paid key you store for OVH or LLM7 would be used. Your own `config.json` is not restricted.

## Caveats

- Free tiers may log prompts or use them for training: Kilo, NVIDIA's trial endpoints and OpenRouter's free providers say so. Do not send them anything you would not post.
- pi labels the virtual-model API vazhi is built on experimental, and vazhi's retry handling follows pi's retry rules. Tested with pi 1.1.0.
- Free limits change often. The nightly run catches models that stop answering, but the capacity figures in `scripts/rank.ts` are a dated reading of each provider's terms (2026-10-11).

## Development

```bash
npm install
npm test                                   # router, pool, ranking, hooks
npm run typecheck
NVIDIA_API_KEY=... node scripts/discover.ts --dry-run   # print tonight's pool without writing
pi -e ./src/index.ts                       # run pi with this checkout
```

Coding scores come from Artificial Analysis, https://artificialanalysis.ai/. The provider list started from [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

## License

MIT
