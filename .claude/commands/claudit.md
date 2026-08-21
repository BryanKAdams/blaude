---
description: Have Claude audit the current work, even when this session is running on a local model
argument-hint: [opus|sonnet|haiku] [what the task was]
---

Run a Claude audit of the work in this session via Blaude. This reaches Claude
through the official CLI (your subscription), so it works even when this session
is being served by a local model and even after the main allowance has run out —
audits draw on their own reserved floor.

Steps:

1. Work out what the task was. Prefer the user's own words from this
   conversation. If `$ARGUMENTS` contains a task description after the model
   name, use that instead.
2. Pick the model: if `$ARGUMENTS` starts with `opus`, `sonnet`, or `haiku`, use
   it; otherwise omit `--model` and let the audit floor's configured model apply.
3. Run the audit, passing the task as the positional argument:

   ```bash
   blaude audit "<task description>" [--model <model>]
   ```

   Add `--tests "<command>"` when this repo has a fast test command worth
   including, and `--base <ref>` when the interesting diff is not against HEAD.
4. Report the findings verbatim-ish: keep every concrete bug and missed
   requirement, drop filler. Then state plainly which findings you agree with and
   which you think are wrong, with a reason.
5. Do not start fixing anything unless the user asks. The audit is information.

If `blaude` is not on PATH, run it as `node /path/to/blaude/bin/blaude.mjs audit …`.
