#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main().catch((err) => {
  console.error(`\x1b[31mblaude:\x1b[0m ${err.message}`);
  if (process.env.BLAUDE_DEBUG) console.error(err.stack);
  process.exit(1);
});
