# Blaude

Keep working in Claude Code when your Claude allowance is gone — without buying
usage credits.

Blaude is a local gateway that speaks Anthropic's Messages API. Stock Claude Code
points at it, and Blaude decides per request whether Claude or a local model
answers, based on how much of your **real** subscription allowance is left.

```
              your terminal
                    │
              claude (stock)
                    │  ANTHROPIC_BASE_URL=http://127.0.0.1:8817
                    ▼
        ┌───────────────────────┐
        │   Blaude  gateway     │
        │                       │  reads `claude /usage` (free, exact)
        │  purpose classifier   │  main · tools · audit · background
        │  allowance floors     │  "Claude until 20% remains"
        │  turn affinity        │  handoff lands on the next prompt
        │  context fitter       │  trims to what the local model accepts
        └───────────┬───────────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  local model              Claude (your subscription)
  Ollama / MLX             via the official `claude` CLI
  LAN or this machine      no API key, no credits
  $0                       audits, escalations, real web search
```

**The guard is what makes it a layer rather than a wrapper.** In a native Claude
session Blaude is not in the request path, so it installs a `UserPromptSubmit`
hook that checks your allowance before every prompt and blocks once you hit the
floor, telling you to continue locally. You cannot silently run out.

```bash
blaude guard on     # then open /hooks once so Claude Code picks it up
```

Everything client-side keeps working, because Blaude does not replace Claude
Code — it sits underneath it. `@file` mentions, slash commands, skills, plugins,
MCP servers, hooks, shift+tab permission modes, images, `/resume`: all unchanged.
Tools still execute in your working directory. Only the model changes.

## Quick start

```bash
ln -s "$PWD/bin/blaude.mjs" ~/.local/bin/blaude   # anywhere on your PATH

blaude use               # list local models, pick one
blaude route gateway     # keep Blaude in the request path for every session
blaude doctor            # backends, tool support, context cap, allowance
blaude status            # where each kind of request goes right now
blaude                   # start a session
```

`blaude` with no arguments is the normal entry point. It reads your allowance,
decides whether this session should run on Claude or locally, and launches Claude
Code accordingly. Extra arguments pass straight through (`blaude -c`,
`blaude "fix the flaky test"`). A mistyped command is refused rather than
silently sent as a prompt — `blaude model x` suggests `blaude mode` instead of
spending a Claude turn on it.

## Choosing a policy

A **floor** is how much allowance must still remain for a purpose to be worth
spending Claude on. `mode` sets sensible floors; override any of them.

```bash
blaude mode                              # list modes and their floors
blaude mode claude-first --floor 20%     # Claude until 20% remains, then local
blaude mode local-first                  # local does the work, Claude audits
blaude mode split --floor main=35,audit=5
```

| mode | main | tools | audit | background |
|---|---|---|---|---|
| `local-only` | local | local | local | local |
| `local-first` | local | local | Claude to 5% | local |
| `claude-first` | Claude to 20% | Claude to 20% | Claude to 5% | local |
| `split` | Claude to 35% | local | Claude to 5% | local |

Requests are classified by what they observably are:

- **main** — a fresh human prompt; the model is being asked to think
- **tools** — an agent-loop continuation (the last message carries tool results)
- **audit** — explicitly tagged (`audit/` prefix, or `blaude audit`)
- **background** — Claude Code's cheap side-calls (titles, summaries)

Lower floors for `audit` and `tools` than for `main` give you reserved tails: the
ordinary grind falls back to local first, while audits and otherwise-impossible
tool calls keep a slice of Claude in reserve.

Try policies against your own history before committing to one — this spends
nothing:

```bash
blaude simulate --days 7 --verbose
```

## Two paths, and why both exist

| | native Claude session | Blaude-hosted session |
|---|---|---|
| chosen when | policy says Claude | policy says local |
| gateway in path | no | yes |
| prompt caching | full (fast, cheap) | n/a (local is free) |
| routing | fixed for the session | dynamic per request |
| enforcement | the **guard hook** | the gateway |
| in-session override | — | `/model local/blaude`, `/model cloud/opus` |

A running native session cannot be switched to a local model — the base URL is
fixed at launch. So the handoff is a restart that keeps your context:

```bash
blaude -c              # continue this exact conversation, locally
blaude resume --last   # or start fresh with a compressed briefing
```

Inside a Blaude-hosted session you get `/bstatus`, `/bhandoff`, `/claudit` and
`/bresume`, and `!blaude <anything>` runs a Blaude command directly.

## The handoff

When the floor is crossed mid-turn, Blaude does **not** switch models. Re-caching
a long conversation is expensive, and handing a local model a half-finished
Claude turn is worse. The turn finishes where it started and the switch lands on
the next prompt, where it costs nothing: Claude is simply not called again.

A hard stop (default: 2% remaining) overrides that, so a runaway turn cannot burn
through the last of your allowance.

## After the handoff

```bash
blaude audit "what the task was"     # Claude reviews the diff, on its own floor
blaude resume --last                 # continue a Claude session locally, free
blaude note "decided X because Y"    # per-project notes that survive handoffs
blaude search "query"                # real web search for the local model
```

Two slash commands are included for use inside a session:

- `/claudit` — have Claude audit the current work, even from a local session
- `/bresume` — continue a previous Claude session on the local model

`blaude resume` reads the session transcript off disk. No API call, no tokens,
works with zero allowance left. A 1.09M-character session compresses to ~20k
characters of briefing.

## Local models

```bash
blaude use                             # list installed models, marked with the current one
blaude use qwen3:27b                   # switch (points both roles at one model)
blaude ollama                          # daemon state, loaded models, context cap
blaude ollama context 65536 --apply    # raise the cap (restarts Ollama)
blaude remote http://192.168.1.50:11434 --model qwen3:32b
scripts/setup-mlx.sh <hf-model-id>     # MLX on Apple Silicon
```

`blaude use` records the context window Ollama can actually give you — the
model's own maximum capped by the daemon setting — rather than the model's
advertised ceiling, so the context fitter works from a real number. It also
points the background role at the same weights by default, because two resident
models split your memory and both end up with less context.

A dedicated box on your LAN works: point `blaude remote` at it. The remote host
must serve beyond localhost (`OLLAMA_HOST=0.0.0.0 ollama serve`). Neither Ollama
nor Blaude authenticates anything, so keep this on a network you trust.

MLX is the better backend for a large model on Apple Silicon: it uses the model's
own context length instead of a daemon-wide cap, and unified memory means no
separate VRAM budget.

## What we measured

Findings from building this on an M4 Pro / 48 GB, all reproducible with
`blaude doctor`:

- **`claude -p "/usage"` is free.** It is a client-side command: zero tokens,
  `total_cost_usd: 0`, ~1.1s. That makes exact allowance percentages available to
  a gateway, which is what the whole policy engine stands on.
- **Ollama truncates silently, and its ceiling moves.** Default context here was
  16,386 tokens; Claude Code sends 20k–40k. The overflow is dropped from the
  *front*, taking the system prompt and tool definitions with it, so the agent
  degrades in a way that looks like a stupid model rather than a misconfigured
  daemon. Per-request `num_ctx` does **not** override the daemon ceiling, so
  raise it with `blaude ollama context 65536 --apply`. Even then Ollama sizes
  context to fit memory: one resident model got 40,960 tokens, two resident
  models got ~20k and ~16k each. Keep **one** model resident (point
  `blaude-small` at the same weights) and Blaude will read the real allocated
  figure from `/api/ps` at request time and fit prompts to it.
- **CLI escalation costs ~24k tokens cold, ~2.6k warm.** Each `claude -p` primes
  a session, but Anthropic's prompt cache means a second escalation inside the
  cache window re-*reads* that prefix instead of recreating it: measured 24k
  weighted cold against 2.6k warm. Blaude also strips MCP servers, hooks,
  plugins and bundled skills from the child (`leanFlags()`), which took a cold
  call from ~24k to 8.5k and 4.5s to 2.0s. `--bare` would cut more but forces
  API-key auth, defeating the point. Bursty escalation is cheap; one escalation
  every ten minutes pays full price each time.
- **`WebSearch` runs client-side but queries Anthropic's service.** A local model
  can call it and Claude Code will execute it, but results come back empty
  without Anthropic auth — and a small model handed an empty result set invents an
  answer with a fabricated citation. Blaude therefore withholds `WebSearch` from
  local models by default and offers `blaude search` instead.
- **Latency, not intelligence, is the practical limit.** qwen3:8b served a real
  Claude Code turn at 5–11 tok/s with a 72s time-to-first-token on a 17.8k prompt.
  Prompt evaluation dominates. A 27B model will be slower per token.

## What Blaude will not do

- **Relay subscription-authenticated requests.** Lifting your OAuth token out of
  the Keychain would enable seamless mid-session Claude relay, but it means using
  your subscription credential outside the official client — an account-risk and
  terms gray area. Cloud escalation goes through the `claude` CLI instead. Direct
  API passthrough exists (`cloudTransport: "api"`) but costs credits and is off by
  default.
- **Claim to know Anthropic's quota math.** `/usage` gives exact percentages;
  everything else (token weights, ceilings) is an estimate, and Blaude labels it
  as one. `blaude calibrate` prefers evidence in this order: live `/usage`
  percentages → moments you actually got a 429 → peak observed usage.
- **Pretend the local model is as good.** It is not. `blaude audit` exists
  because reviewing local work with Claude is the cheapest way to catch it being
  confidently wrong.

## Commands

| command | what it does |
|---|---|
| `blaude` | start a session, routed by policy |
| `blaude status` | allowance, routing table, gateway state |
| `blaude usage` | real Claude usage on this machine |
| `blaude why [model]` | explain where each kind of request would go |
| `blaude simulate` | try policies against your history, free |
| `blaude calibrate` | derive token ceilings for the fallback estimator |
| `blaude mode [name]` | list or set the mode |
| `blaude doctor` | backends, tool support, context cap, allowance |
| `blaude audit "task"` | Claude reviews the current diff |
| `blaude resume` | continue a Claude session locally |
| `blaude search "q"` | web search for the local model, via Claude |
| `blaude use [model]` | pick which local model to serve |
| `blaude route [auto\|gateway]` | whether Blaude stays in the request path |
| `blaude guard [on\|off]` | stop native Claude sessions at your floor |
| `blaude ollama` | inspect or raise the Ollama context cap |
| `blaude remote <url>` | use an Ollama on another machine |
| `blaude note "text"` | per-project notes |
| `blaude stats` | what Blaude has served |
| `blaude serve` | run the gateway in the foreground |
| `blaude init` | write a config file |

Model prefixes override policy for one request: `local/blaude-small` forces
local, `cloud/opus` forces Claude, `audit/opus` classifies as an audit.

## Configuration

`~/.blaude/config.json`, or `./blaude.config.json` for a per-project override.
See `blaude.config.example.json` for every field with commentary.

## Development

```bash
npm test        # 76 tests, no network, no dependencies
```

Zero runtime dependencies; Node ≥ 20. The pieces:

| file | responsibility |
|---|---|
| `src/server.mjs` | the gateway: endpoints, routing, streaming |
| `src/policy.mjs` | purpose classification, floors, turn affinity |
| `src/usage-command.mjs` | reads `/usage` (the authoritative source) |
| `src/claude-usage.mjs` | transcript-based fallback + 429 anchors |
| `src/anthropic-to-openai.mjs` | request translation |
| `src/openai-to-anthropic.mjs` | response translation |
| `src/stream.mjs` | Anthropic SSE event machine |
| `src/text-scanner.mjs` | `<think>` / `<tool_call>` parsing, streaming-safe |
| `src/ollama-backend.mjs` | Ollama's native API as an OpenAI shape |
| `src/fit-context.mjs` | deliberate prompt trimming |
| `src/claude-cli.mjs` | subscription escalation via `claude -p` |
| `src/handoff.mjs` | free session handoff from transcripts |
| `src/ollama-admin.mjs` | daemon context cap; real allocated context |

Everything that depends on undocumented Claude Code internals is confined to
`usage-command.mjs`, `claude-usage.mjs`, and `claude-cli.mjs` — if a format
changes, that is where to look.

## Measured: local + Claude's search vs Claude alone

One question, both paths, real runs. "What is the latest Kingdom Hearts IV news,
including the recent Coco trailer?"

| | Claude direct | local model + `blaude search` |
|---|---|---|
| Claude tokens (weighted) | 47,334 | **18,515** |
| local tokens | 0 | 13,934 (free) |
| wall clock | 19.3s | 58.8s |
| facts correct | 3/3 | 3/3 |
| sources | identical URLs | identical URLs |

61% fewer Claude tokens, three times slower, same three facts. Claude direct was
richer — it added platforms and a developer quote the local model did not. Which
is the honest shape of the trade: on a search-grounded question the local model
is a cheap formatter over Claude's retrieval, not a replacement for its judgement.

## Prior art

Routing Claude Code to other models is well-trodden:
[claude-code-router](https://github.com/musistudio/claude-code-router),
[claude-code-proxy](https://github.com/nielspeter/claude-code-proxy), LiteLLM,
and LM Studio's native support all do the protocol translation. Blaude's
difference is that routing is driven by your **remaining subscription
allowance**, read from `/usage`, with handoffs on turn boundaries. Anthropic has
open feature requests for automatic fallback at the limit
([#43260](https://github.com/anthropics/claude-code/issues/43260),
[#2944](https://github.com/anthropics/claude-code/issues/2944)); if that ships,
much of this becomes unnecessary, which would be a good outcome.

Not affiliated with or endorsed by Anthropic.
