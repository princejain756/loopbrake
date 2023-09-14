# loopbrake

Detect and break coding-agent edit-thrashing.

A coding agent that cannot fix a bug will patch the same file over and over
instead of stepping back and redesigning the module. `loopbrake` reads local
Claude Code transcripts (`~/.claude/projects/*.jsonl`) and reports every source
file that an agent mutated four or more times in a single session, so the band-aid
turns are visible after the fact.

## Usage

```bash
# Audit the default Claude Code transcript directory
node ./bin/loopbrake.mjs

# Audit an explicit directory of .jsonl transcripts
node ./bin/loopbrake.mjs ./logs
```

Each report line looks like `6x fno.py (rollout-01a1784f.jsonl) via apply_patch`,
followed by the `LPB001` finding with its severity and evidence string.

## License

MIT © [Prince Jain](https://github.com/princejain756)
