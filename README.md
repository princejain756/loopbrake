# loopbrake

Detect and break coding-agent edit-thrashing.

A coding agent that cannot fix a bug will patch the same file over and over
instead of stepping back and redesigning the module. `loopbrake` reads a Claude
Code transcript (`.jsonl`, one event object per line) and records every
source-file mutation with the tool that made it, so the band-aid turns are visible
after the fact.

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
