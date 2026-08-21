---
description: Show Blaude routing and remaining Claude allowance
---

Report where requests are going right now and how much Claude allowance is left.

```bash
blaude status
```

Then state, in two or three lines: which window is binding, whether this session
is being served by Claude or the local model, and what will happen next (a
handoff at the floor, or nothing). If the allowance is at or under the floor,
remind the user they can continue locally with `blaude -c` — same conversation,
no allowance spent.

Do not run any other Blaude command unless asked.
