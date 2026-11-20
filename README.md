# vazhi

A free LLM router for the [pi coding agent](https://pi.dev). Pick the model `vazhi/auto` and each request goes to the best free model that is answering right now. If that model fails or hangs, the request moves to the next one, and every pi session on the machine skips the failed model until it recovers.

The model list is rebuilt every night. CI sends each free model a tool-calling request and ranks the ones that answer. Installed copies download the new list on their own.

vazhi is Tamil for "way".

## Install

```bash
pi install npm:@itsgg/vazhi
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
| `groq` | console.groq.com | the fast list only: Qwen3.8 27B and GPT-OSS answer in under a second; 30 requests a minute, 1,000 a day |

Use keys from free plans. A paid key is billed by its provider, for example a Google key on a project with billing enabled.

## Commands

`/vazhi` shows the pool and what is cooling down. `/vazhi reset` clears the cooldowns. `/vazhi update` downloads the latest pool now.

## Command line

The same router runs without pi. `vazhi ask` sends one question to the best free model that is up and prints the answer:

```bash
vazhi ask "what does the -S flag of ls do"
git diff | vazhi ask --system "Write a one-line commit subject for this diff."
vazhi ask --fast --system "Reply with one bash command." "find files over 1GB"
```

`--fast` asks the fast list instead of the coding pool: models that answer short questions in about a second, Groq first. When the first has not answered within 1.5 seconds, a second is asked too and the first answer wins. `--json` prints the answer with the model and the time taken. The exit status is 0 for an answer, 1 when no model answered, 2 for bad usage.

`vazhi status [--fast]`, `vazhi reset` and `vazhi update` do what `/vazhi` does in pi. The command line shares pi's state and keys: a model cooling in pi is skipped here, and the other way round. Keys come from pi's `~/.pi/agent/auth.json`, then from `GROQ_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY` and `ZAI_API_KEY`. Without any, Kilo and OVH still answer.

To use the command line without pi, `npm install -g --legacy-peer-deps @itsgg/vazhi`; the flag skips pi's packages, which only the extension needs. Its state (cooldowns, the downloaded pool and `config.json`) still lives in pi's directory, `~/.pi/agent/vazhi`, so the two share it when both are installed; set `PI_CODING_AGENT_DIR` to keep it somewhere else.

From JavaScript, `import { ask } from "@itsgg/vazhi/core"` does the same.

## How it works

vazhi tries the pool in order and skips models that are cooling down. Within one turn it stays on the same model unless that model fails or is slow.

A failed model cools down for as long as the provider asks. Otherwise the error decides: 30 seconds for a rate limit, 15 minutes for a hang, an hour for a spent daily quota, 6 hours for a rejected key. Repeat failures double the time.

NVIDIA's free tier can hold a request for up to an hour when it has no capacity. While vazhi routes, it asks NVIDIA to give up after 5 seconds, so the request moves on in about 7. A model that takes more than 15 seconds to start answering goes behind faster models for 10 minutes.

pi's "Working" line shows which model vazhi is asking.

## How the pool is built

Each night a GitHub Action lists the free models with tool calling in each provider's catalog and sends every one a test request. A model that fails twice in a row, or fails before it has ever passed, is left out until it passes again.

The rest are ranked by quality times capacity. Quality is the [Artificial Analysis](https://artificialanalysis.ai/) coding index, or a manual score in `data/seed-scores.json` for models AA does not cover. Capacity reflects how much free use the provider allows. Once a week CI runs three small coding tasks through pi on the top ten models, and the pass rates adjust the scores.

The fast list is ranked by hand in `data/fast.json` from a latency probe and copied into the nightly file, under the same free rules.

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

`exclude` drops models or whole providers, from the pool and the fast list. `prefer` moves models to the front of the pool. `pool` and `fast` replace either list with your own, as `{ "model": "provider/id" }` entries; a fast entry may add `"effort": "none"`, `"minimal"` or `"low"`, sent as the model's reasoning effort. `autoUpdate: false` stops the nightly download.

## Safety

The downloaded list names models, never URLs or keys. Base URLs live in `src/providers.ts`, and each provider has a rule there that admits only its free models. A tampered list cannot send your prompts anywhere new or move you to a paid model. Your own `config.json` is not checked.

## Caveats

- Free tiers may log prompts or train on them. Kilo, NVIDIA and OpenRouter's free providers say so.
- vazhi builds on pi's virtual-model API, which pi marks experimental. Tested with pi 1.6.0.
- Free limits change often. The capacity figures in `scripts/rank.ts` date from 2026-10-11.

## Development

```bash
npm install
npm test
npm run typecheck
```

The command line from this checkout:

```bash
node src/cli.ts ask --fast "hello"
```

Tonight's pool, printed without writing it; with NVIDIA_API_KEY set, NVIDIA's models are probed too:

```bash
node scripts/discover.ts --dry-run
```

pi with this checkout as its extension:

```bash
pi -e ./src/index.ts
```

Coding scores come from [Artificial Analysis](https://artificialanalysis.ai/). The provider list started from [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

## License

MIT
