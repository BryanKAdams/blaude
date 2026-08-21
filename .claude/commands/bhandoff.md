---
description: Hand this conversation to the local model, keeping the context
---

Move this work onto the local model without losing what has happened.

1. Run `blaude status` and tell the user the current allowance and destination.
2. Explain that Blaude cannot switch the model of a *running* native Claude
   session — the switch happens by restarting. Their options:
   - `blaude -c` — continue this exact conversation on the local model
   - `blaude resume --last` — start fresh with a compressed briefing of it
   - `blaude --local` — a clean local session
3. If they are already in a Blaude-hosted session, say so: routing is already
   dynamic per request, and they can force a destination per turn with
   `/model local/blaude` or `/model cloud/opus`.
4. Do not exit the session yourself, and do not run `blaude -c` from inside this
   session — that would nest a second Claude Code inside this one. Tell the user
   to run it in their terminal.
