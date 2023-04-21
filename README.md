# loopbrake

Detect and break coding-agent edit-thrashing.

A coding agent that cannot fix a bug will patch the same file over and over
instead of stepping back and redesigning the module. `loopbrake` reads Claude Code
transcripts (`.jsonl`, one event object per line) and reports every source file an
agent mutated four or more times in a single session, so the band-aid turns are
visible after the fact.

## Usage

```bash
# Scan the default ~/.claude/projects log directory
node ./bin/loopbrake.mjs

# Scan an explicit directory or single transcript
node ./bin/loopbrake.mjs ./logs
node ./bin/loopbrake.mjs ./logs/session-01.jsonl
```

Each line of output is one thrashing file with the tools that touched it:

```
6x fno.py (rollout-01a1784f.jsonl) via Edit, MultiEdit
```

## Library

```js
import { collectMutations, rankByMutations } from './src/analyzer.mjs';

for (const { file, edits, methods } of rankByMutations(collectMutations('session.jsonl'))) {
  console.log(`${edits}x ${file} via ${methods.join(', ')}`);
}
```

`Edit` and `Write` count as one mutation each, and a `MultiEdit` counts as one
mutation per hunk it carries, so a single call that rewrites five regions ranks
above five separate one-line patches.
