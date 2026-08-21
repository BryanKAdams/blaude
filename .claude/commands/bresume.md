---
description: Continue a previous Claude session on the local model, for free
argument-hint: [session-id | --last]
---

Pick up where a Claude session left off, using the local model. This reads the
session transcript off disk — no API call, no tokens, works with zero allowance
remaining.

1. If `$ARGUMENTS` is empty, run `blaude resume` to list the recent sessions for
   this project and show the user the list. Ask which one they mean; do not guess.
2. Otherwise print the briefing rather than launching a nested session:

   ```bash
   blaude resume $ARGUMENTS --print
   ```
3. Read the briefing carefully. It contains the user's original intent, what
   Claude did, which files were touched, and the recent history. File *contents*
   are deliberately excluded.
4. State in one or two sentences what state the work is in and what you believe
   the next step is. Then re-read whichever files you actually need — do not
   assume their contents from the briefing.
5. Continue the work. Do not restart it or re-plan from scratch.

If `blaude` is not on PATH, use `node /path/to/blaude/bin/blaude.mjs resume …`.
