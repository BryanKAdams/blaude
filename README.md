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

## What you need first

Blaude routes between Claude Code and a local model, and installs neither. Both
sides have to be working before it has anything to route between.

| | why |
|---|---|
| **Node 20+** | Blaude uses built-in `fetch` and `node:test`, and has no dependencies |
| **Claude Code**, logged in | Blaude launches it, and reads `/usage` for your real allowance |
| **A Claude subscription** (Pro or Max) | allowance routing is the entire point; a pay-per-token API key has no `/usage` to read |
| **Ollama** with one model pulled | the local half. MLX on Apple Silicon works too |

```bash
npm install -g @anthropic-ai/claude-code    # then run `claude` once to log in
brew install ollama && ollama serve         # or https://ollama.com
ollama pull <a tool-capable model>          # see "Which model" below
```

Pick a model that **supports tool calling** — a coding agent is mostly tool
calls, and a model that cannot make them cannot do the work. `blaude doctor`
probes for this and tells you which of native, text-parsed, or no tool calling
you actually got.

## Install

Blaude itself:

```bash
curl -fsSL https://raw.githubusercontent.com/BryanKAdams/blaude/main/install.sh | bash
```

That unpacks the latest release into `~/.blaude/versions/<version>` and links
`blaude` into `~/.local/bin`. Because every version keeps its own directory,
`blaude update` is a symlink swap and `blaude update --rollback` is instant.

To run from a clone instead — the right choice if you intend to hack on it:

```bash
git clone https://github.com/BryanKAdams/blaude.git
cd blaude
npm install                                       # dev only: the type checker
npm test                                          # types + 126 tests
ln -s "$PWD/bin/blaude.mjs" ~/.local/bin/blaude   # anywhere on your PATH
```

Blaude has **no runtime dependencies** — `npm install` here pulls TypeScript and
`@types/node` only, to typecheck the JSDoc. What you run has an empty dependency
tree, which for a process sitting in your agent's request path is deliberate.

## Quick start

```bash
blaude doctor            # start here: claude CLI, backends, tool support, context cap
blaude use               # list local models, pick one
blaude route auto        # Claude does the work while you have allowance
blaude status            # where each kind of request goes right now
blaude                   # start a session
```

Run `blaude doctor` first. It is the one command that tells you whether the
pieces above are actually in place — and it catches the failure that looks like
a bad model but is really a bad setting: an Ollama context window too small for
the 20k-40k token prompts Claude Code sends, which silently truncates your
system prompt and tool definitions.

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
blaude mode claude-audits                # local does the work, Claude audits
blaude mode claude-first --floor main=35,audit=5
blaude mode claude-first --floor audit=never
```

| mode | main | tools | audit | background |
|---|---|---|---|---|
| `local-only` | local | local | local | local |
| `claude-audits` | local | local | Claude to 5% | local |
| `claude-first` | Claude to 20% | Claude to 20% | Claude to 5% | local |

`claude-audits` was called `local-first`; the old name still resolves, because it
read as "prefer local, fall back to Claude automatically", which is not what it
does — every turn is local and Claude is reachable only for review.

Floors take `20`, `0.2` or `"20%"`, and `never` (or `1`) to keep a purpose local
always. Write single digits with the percent sign — a bare `1` is the "never"
sentinel, so `--floor audit=1%` and `--floor audit=1` mean opposite things.

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

`thinking` controls what Claude Code sees after a local model answers. It does
not disable the model's reasoning by itself. The shipped `localThinking: false`
keeps the fast default; set it to `null` to let Ollama use its native default,
or to `true` or a supported level such as `low`, `medium`, `high`, or `max` to
control reasoning explicitly. Anthropic request-level thinking controls take
effect automatically when `localThinking` is `null`.

### Which model

What worked best on an M4 Pro / 48 GB, by a wide margin:

```bash
ollama pull codecraftersllc/ornith-1.5-35b-a3b-abliterated:latest
```

The useful part is *why*, because it generalises past this one model. **A3B means
mixture-of-experts with roughly 3B active parameters**, so despite being nominally
35B it prefills and generates like a small model while answering like a large
one. Since prefill is what you wait for — see *What we measured* — active
parameter count matters far more than the headline size. A dense 27B is the
slower choice even though the number is smaller.

The Qwen3 builds were all worse here: too slow to use, or they fell into
repetition loops. `qwen3.6:27b-modelopt-nvfp4` in particular is quantised in a
format aimed at NVIDIA hardware, which is not what a Mac is running.

Two caveats on the recommendation. It is one person's result on one machine, not
a benchmark — your mileage will differ, and `blaude doctor` is how you find out
rather than guessing. And "abliterated" means the model's refusal behaviour has
been stripped out by a third-party fine-tune; it is popular for coding because it
stops declining ordinary work, but you are running an unaligned model from an
unofficial repo, which is worth knowing rather than discovering.

### Running a 27B-class model

Prefill, not generation, is what you wait for — so the wins are all in sending
fewer tokens and sending the same ones twice. Blaude does both by default
(`localTools`, `simpleSystemPrompt`; see *What we measured*). Two things it
cannot do for you:

- **`OLLAMA_NUM_PARALLEL=1`.** More slots let two heavy requests share one GPU and
  halve each other: measured 173s and 94s for a concurrent pair, against 2.9s for
  the same work run alone. Raise it only if you want the Ollama GUI to stay
  responsive while Blaude is busy, and know you are trading throughput for it.
- **Keep one model resident.** Ollama sizes context to fit memory, so a second
  model does not just cost RAM, it shrinks the window of the first. `blaude use`
  points both roles at the same weights for this reason.

The gateway holds code in memory: `blaude serve` does hot-reload `config.json`,
but **not** source. After changing Blaude itself, kill the running gateway or
your session keeps using the old code — the logs will still say
`config reloaded` while nothing else changes.

### Known upstream issues

Neither is Blaude's, both are worked around, and both are worth recognising in a
log rather than mistaking for a bad model:

- **gemma4 on Ollama's MLX runner returns empty turns.** On the turn *after* a
  tool result it produces no content and no tool calls roughly 7 times in 10,
  having generated exactly 3 tokens (`eval_count=3`, `done_reason=stop`) that its
  parser consumes. The agent reads the empty turn as a finished one and stops.
  Blaude retries (`emptyCompletionRetries`), which takes it from ~30% to ~88%
  usable — but each retry is a fresh prefill, so qwen remains the better choice
  for agentic work.
- **The MLX runner subprocess sometimes dies mid-request**, surfacing as
  `500 {"error":"Post .../v1/completions: EOF"}` after minutes of work. If a turn
  runs long, `grep 500 ~/.blaude/gateway.log` tells you whether you are watching
  a slow prefill or a crash.
- **Newer Claude Code builds can put a `system` message in the middle of the
  conversation.** Strict Ollama templates reject that with `system message must
  be at the beginning`; Blaude coalesces those messages into the leading system
  prompt before translation.

## What we measured

Findings from building this on an M4 Pro / 48 GB. The backend and context
figures are reproducible with `blaude doctor`; the prompt-size and prefill
numbers below were captured from real sessions and are quoted as measured, not
as guarantees for your hardware:

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
  Prompt evaluation dominates, and it dominates harder as models grow.
- **Claude Code's fixed overhead is larger than a 27B's whole context window.**
  Captured from a real one-word prompt: 7,629 tokens of system prompt and 27,549
  of tool definitions across 25 tools — a **35,178-token floor** before you type
  anything, against the 32,768 such a model runs in. Tool definitions are 78% of
  it, and the largest are orchestration a local model never calls: `Workflow`
  alone is 5,927 tokens, roughly a minute of prefill every turn. Blaude drops
  those for local routes (`localTools`) and asks Claude Code for its abbreviated
  prompt (`simpleSystemPrompt`), which together take the floor to **5,399**.
  Neither applies to Claude, which has prompt caching and does not care.
- **Ollama caches the prefix, but only if you keep it identical.** It does not
  support Anthropic's `cache_control`, and does not need to — its runner keeps a
  KV prefix cache automatically. Measured on the same 21k prefix three turns
  running: 178.4s → 42.0s → 0.3s. The catch is that it matches a *byte-identical*
  prefix, so anything that rewrites the front of the prompt between turns throws
  the cache away. Blaude's own trimming used to do exactly that — 19 tool
  descriptions cut on one request and 23 on the next — which is why logs showed
  `matched=0` forever. Shrinking the prompt matters; keeping it *stable* matters
  as much.
- **Measured on qwen3.6 27B (M4 Pro / 48 GB, Ollama's MLX runner).** Prefill runs
  at ~100–120 tok/s, so cost is set almost entirely by prompt size. Before the
  two changes above: 28,730–80,255-token prompts, 150s–900s per turn, and turns
  that timed out client-side while the backend kept grinding. After: ~9,000-token
  prompts, a **2.9s** warm turn against a cache reporting `matched=9011/9066`.
  The first turn of a session still pays a full cold prefill — expect ~60–90s —
  and nothing makes that free.

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
| `blaude update` | install the latest release (`--check`, `--rollback`) |

Model prefixes override policy for one request: `local/blaude-small` forces
local, `cloud/opus` forces Claude, `audit/opus` classifies as an audit.

## Configuration

`~/.blaude/config.json` is the base; `./blaude.config.json` layers over it, so a
project file need only name what it changes. `BLAUDE_CONFIG` replaces both, so an
isolated config stays isolated. See `blaude.config.example.json` for every field
with commentary.

## Development

```bash
npm install     # dev only: TypeScript, for the JSDoc check
npm test        # typecheck + 126 tests, no external network
npm run typecheck
```

Zero *runtime* dependencies; Node ≥ 20.

`npm test` runs `tsc --checkJs` before the suite. Blaude never compiles — the
tarball is the source — so the checker only ever reads, and it exists for one
layer: the protocol translation, where a wrong shape becomes a mangled tool call
instead of a crash. Those files (`anthropic-to-openai`, `openai-to-anthropic`,
`stream`, `text-scanner`, `fit-context`) are clean and the build fails if that
changes. `src/wire-types.mjs` holds the shapes; it is JSDoc only and emits
nothing. Files still carrying `// @ts-nocheck` are the backlog — delete the line
and fix what it reports.

The pieces:

| file | responsibility |
|---|---|
| `src/server.mjs` | the gateway: endpoints, routing, streaming |
| `src/policy.mjs` | purpose classification, floors, turn affinity |
| `src/usage-command.mjs` | reads `/usage` (the authoritative source) |
| `src/claude-usage.mjs` | transcript-based fallback + 429 anchors |
| `src/wire-types.mjs` | JSDoc shapes for both wire protocols (no runtime code) |
| `src/anthropic-to-openai.mjs` | request translation |
| `src/openai-to-anthropic.mjs` | response translation |
| `src/stream.mjs` | Anthropic SSE event machine |
| `src/text-scanner.mjs` | `<think>` / `<tool_call>` parsing, streaming-safe |
| `src/ollama-backend.mjs` | Ollama's native API as an OpenAI shape |
| `src/fit-context.mjs` | deliberate prompt trimming; local tool selection |
| `src/claude-cli.mjs` | subscription escalation via `claude -p` |
| `src/handoff.mjs` | free session handoff from transcripts |
| `src/ollama-admin.mjs` | daemon context cap; real allocated context |
| `src/update.mjs` | in-place updates from GitHub Releases, and rollback |

Everything that depends on undocumented Claude Code internals is confined to
`usage-command.mjs`, `claude-usage.mjs`, and `claude-cli.mjs` — if a format
changes, that is where to look.

## Measured: is "local works, Claude checks" cheaper than just using Claude?

Yes for one audit at the end; emphatically no for a review every turn. Same task
(count the TODOs under src/, ground truth 7 and `api.py`), same local pass shared
across arms so the only variable is the Claude layer on top. Local model
Qwen3-27B at a 32k context; auditor and baseline both Sonnet.

| arm | Claude tokens | requests | wall | correct |
|---|---|---|---|---|
| Claude direct | 24.2k | 3 | 8.1s | yes |
| local only | **0** | 0 | 797s | yes |
| local + **one** audit | **18.9k** (78%) | 3 | 492s | yes |
| local + **per-turn** review | 68.7k (364%) | 17 | 870s | yes |

- **One audit beats using Claude, by 22%.** Claude never opens the files: it gets
  a compact brief and verifies. The audit call itself took 15.7s.
- **Per-turn review costs 3.6x Claude direct, and it is self-defeating.** The
  reviewer solved the task itself on turn 2 from the local model's tool output,
  then re-asserted that same answer thirteen more times while the local model
  ground on. Give a reviewer enough context to judge the work and you have given
  it enough to do the work. This is why per-turn review is not a feature.
- **The audit changed nothing here**, because the local answer was already
  correct. So there is still no measurement of an audit catching a real error —
  the one time the local model failed, the cause was a context-thrash bug, and
  the reviewer did diagnose that correctly every turn.

Local models, same task, both correct with zero Claude tokens:

| model | wall | turns | per turn once warm |
|---|---|---|---|
| Qwen3-27B | 608s | 9 | **16-27s** |
| Qwen3-8B | 541s | 8 | 70-76s |

The 27B's steady-state turns are roughly 3x faster than the 8B's despite being
three times the size — its logs credit speculative decoding
(`--spec-type draft-mtp`) and prefix-cache checkpoints the 8B run did not get.
There is no speed argument for the smaller model on this machine.

Single task, easy task. Both models succeeding says nothing about harder work.

## Measured: three ways to do the same task

One task ("count the TODOs under src/ and say which file has the most", ground
truth 7 and `api.py`), three routes. Claude spend attributed only to the sessions
each arm created, weighted with cache reads at 0.1.

| arm | Claude tokens | requests | wall | got it right? |
|---|---|---|---|---|
| **A** native Claude | **25.0k** | 3 | **9.7s** | no — said 6 |
| **B** Blaude relays every turn to Claude | 48.7k (195%) | 5 | 41.5s | **no answer at all** |
| **C** local model works, Claude audits once | 55.7k (223%) | 7 | 44.3s | **yes** |

Three things follow, and two of them are unflattering:

- **Relaying ordinary turns to Claude through Blaude is a bad trade** — roughly
  double the tokens and quadruple the wall clock, because each turn spawns a
  fresh `claude -p` and the outer conversation cannot reuse the prompt cache.
  A rerun produced no answer at all. So there is no switch for it — ordinary
  turns stay local with an explanation, and an option nobody should enable is not
  an option, it is a trap. For Claude to do the work, take Blaude out of the
  request path: `blaude route auto` + `blaude guard on`.
- **"Local does it, then Claude checks it" is not a token-efficiency play.** It
  cost more than simply asking Claude, because the audit re-reasons about the
  problem. Its value is quality, not savings.
- **It was the only arm that got the right answer.** Native Claude miscounted;
  the local pass plus an audit did not. A single sample proves nothing about
  models, but it does show the second pass earning its cost.

The honest efficiency story is narrower than "route everything through Blaude":
local work is free, and Claude is worth spending on selectively — for audits when
correctness matters, and for the turns you knowingly hand it.

Coarse one-shots over the same CLI transport (`blaude audit`, `blaude search`)
work reliably; it is only the per-turn relay that does not.

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
