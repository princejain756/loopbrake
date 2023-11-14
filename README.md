# loopbrake

Detect and break coding-agent edit-thrashing and shell-write bypasses.

A coding agent that cannot fix a bug will patch the same file over and over
instead of stepping back and redesigning the module. Worse, if you only count
`Edit` and `Write` calls, the agent routes around your counter with
`cat <<'EOF' > file.py`, `sed -i`, or `Path(...).write_text(...)` inside a shell
command, and the thrash disappears from the numbers.

`loopbrake` reads local Claude Code transcripts (`~/.claude/projects/*.jsonl`) and
attributes both structured edits and shell writes to the source file they touched,
then reports every file mutated three or more times in one session.

## Why the shell writes matter

Counting only `Edit` inflates the structured-edit ratio and hides the worst
sessions. In the local sample that motivated this tool, a third of all source
mutations happened inside shell commands, and the single worst file was rewritten
four times entirely through shell heredocs. `LPB004` reports that ratio so the
bypass is visible instead of invisible.

## Usage

```bash
# Audit the default Claude Code transcript directory
node ./bin/loopbrake.mjs

# Audit an explicit directory of .jsonl transcripts
node ./bin/loopbrake.mjs ./logs
```

Output is a loop-safety score, the thrashed-file table, and one line per finding
with the command or hunk that triggered it:

```
5x fno.py (rollout-01a1784f.jsonl) via BashWrite
MEDIUM LPB004 session-transcripts: 78 of 199 writes (39.2%) bypassed Edit
```

## Detection rules