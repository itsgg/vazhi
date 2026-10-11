# vazhi

A free LLM router for the [pi coding agent](https://pi.dev). Pick the model `vazhi/auto` and each request goes to the best free model that is answering right now. If that model fails or hangs, the request moves to the next one, and every pi session on the machine skips the failed model until it recovers.

The model list is rebuilt every night. CI sends each free model a tool-calling request and ranks the ones that answer. Installed copies download the new list on their own.

vazhi is Tamil for "way".

## Install

```bash
pi install npm:vazhi
```

Or from GitHub: `pi install git:github.com/itsgg/vazhi`.

Then make it the default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "vazhi",
  "defaultModel": "auto",
  "httpIdleTimeoutMs": 45000,
  "retry": { "enabled": true, "maxRetries": 20, "baseDelayMs": 300, "maxAgentDelayMs": 4000 }
}
```

Each retry goes to a different model, so pi needs more than its default of 3. The 45-second idle timeout stops a hung provider from holding a request for five minutes.

## Keys

No key is needed. Without one, vazhi uses Kilo, OVHcloud and LLM7. Free keys add more models. Add them in pi with `/login <provider>`:

| Provider | Key from | Adds |
|---|---|---|
| `nvidia` | build.nvidia.com | GLM 5.3 Flash, Nemotron 3 Ultra and more, up to 40 requests a minute |
| `google` | aistudio.google.com/app/apikey | Gemini Flash, about 20 requests a day, and Flash-Lite |
| `openrouter` | openrouter.ai/keys | 50 free requests a day across its `:free` models |
| `ollama-cloud` | ollama.com/settings/keys | a small monthly credit for its starter models |
| `zai-free` | z.ai | GLM 4.7 Flash, no daily cap |

Use keys from free plans. A paid key is billed by its provider, for example a Google key on a project with billing enabled.

## Commands

`/vazhi` shows the pool and what is cooling down. `/vazhi reset` clears the cooldowns. `/vazhi update` downloads the latest pool now.

## How it works

vazhi tries the pool in order and skips models that are cooling down. Within one turn it stays on the same model unless that model fails or is slow.

A failed model cools down for as long as the provider asks. Otherwise the error decides: 30 seconds for a rate limit, 15 minutes for a hang, an hour for a spent daily quota, 6 hours for a rejected key. Repeat failures double the time.

NVIDIA's free tier can hold a request for up to an hour when it has no capacity. While vazhi routes, it asks NVIDIA to give up after 5 seconds, so the request moves on in about 7. A model that takes more than 15 seconds to start answering goes behind faster models for 10 minutes.

pi's "Working" line shows which model vazhi is asking.

## How the pool is built

Each night a GitHub Action lists the free models with tool calling in each provider's catalog and sends every one a test request. A model that fails twice in a row, or fails before it has ever passed, is left out until it passes again.

The rest are ranked by quality times capacity. Quality is the [Artificial Analysis](https://artificialanalysis.ai/) coding index, or a manual score in `data/seed-scores.json` for models AA does not cover. Capacity reflects how much free use the provider allows. Once a week CI runs three small coding tasks through pi on the top ten models, and the pass rates adjust the scores.

Installed copies check for a new list at each session and turn, and download it once theirs is 12 hours old. Code changes arrive with `pi update --extensions`.

## Configuration

`~/.pi/agent/vazhi/config.json`, every field optional:

```json
{
  "exclude": ["llm7", "google/gemini-3.6-flash"],
  "prefer": ["nvidia/nvidia/nemotron-3-ultra-550b-a55b"],
  "autoUpdate": true
}
```

`exclude` drops models or whole providers. `prefer` moves models to the front. `pool` replaces the list with your own, as `{ "model": "provider/id" }` entries. `autoUpdate: false` stops the nightly download.

## Safety

The downloaded list names models, never URLs or keys. Base URLs live in `src/providers.ts`, and each provider has a rule there that admits only its free models. A tampered list cannot send your prompts anywhere new or move you to a paid model. Your own `config.json` is not checked.

## Caveats

- Free tiers may log prompts or train on them. Kilo, NVIDIA and OpenRouter's free providers say so.
- vazhi builds on pi's virtual-model API, which pi marks experimental. Tested with pi 1.1.0.
- Free limits change often. The capacity figures in `scripts/rank.ts` date from 2026-10-11.

## Development

```bash
npm install
npm test
npm run typecheck
NVIDIA_API_KEY=... node scripts/discover.ts --dry-run   # print tonight's pool
pi -e ./src/index.ts                                    # run pi with this checkout
```

Coding scores come from [Artificial Analysis](https://artificialanalysis.ai/). The provider list started from [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

## License

MIT
