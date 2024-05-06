# loopbrake

Detect and break coding-agent edit-thrashing, shell-write bypasses and tool-error
doom loops.

A coding agent that cannot fix a bug will patch the same file over and over
instead of stepping back and redesigning the module. Worse, if you only count
`Edit` and `Write` calls, the agent routes around your counter with
`cat <<'EOF' > file.py`, `sed -i`, or `Path(...).write_text(...)` inside a shell
command, and the thrash disappears from the numbers.

`loopbrake` reads local Claude Code (`~/.claude/projects/*.jsonl`) and Codex CLI
(`~/.codex/sessions/*.jsonl`) transcripts, attributes both structured edits and
shell writes to the source file they touched, and reports every file mutated three
or more times in one session alongside the error streaks around it.

## Why the shell writes matter

Counting only `Edit` inflates the structured-edit ratio and hides the worst
sessions. In the local sample that motivated this tool, a third of all source
mutations happened inside shell commands, and the single worst file was rewritten
four times entirely through shell heredocs. `LPB004` reports that ratio so the
bypass is visible instead of invisible.

## Usage

```bash
# Audit the default Claude Code and Codex CLI transcript directories
node ./bin/loopbrake.mjs

# Audit an explicit directory of .jsonl transcripts
node ./bin/loopbrake.mjs ./logs
```

Output is a loop-safety score, the thrashed-file table, and one line per finding
with the command, hunk or error output that triggered it:

```
9x  fno.py  (rollout-01a1784f.jsonl)  via apply_patch
CRITICAL  LPB008  5f37b3d3.jsonl: 9 consecutive failing tool calls
        evidence: <tool_use_error>Unknown skill: pony tail.</tool_use_error>
```

## Detection rules

| Rule | Severity | Plane | What it flags |
| :--- | :--- | :--- | :--- |
| `LPB001` | `CRITICAL` | Thrash | 4+ mutations to one source file in a single session |
| `LPB002` | `HIGH` | Thrash | 3 mutations to one source file (band-aid threshold) |
| `LPB003` | `HIGH` | Thrash | Overlapping hunk or self-revert on lines a previous edit wrote |
| `LPB004` | `MEDIUM` | Thrash | Shell-write bypass of `Edit` (`cat <<EOF`, `sed -i`, `.write_text`) |
| `LPB005` | `MEDIUM` | Thrash | Blind edit before any `Read` or inspection of the target file |
| `LPB006` | `INFO` | Guard | Read-only `python3 -c` / `sed -n` inspections excluded from writes |
| `LPB007` | `INFO` | Guard | `.jsonl`-vs-`.js` collisions and doc/manifest churn excluded |
| `LPB008` | `CRITICAL` | Loop | 4+ consecutive failing tool calls (severe doom loop) |
| `LPB009` | `HIGH` | Loop | 2–3 consecutive failing tool calls |
| `LPB010` | `CRITICAL` | Loop | Deleted-sandbox CWD escape recovering the shell into `~` |

## Limitations

Shell-write parsing is heuristic. It recognises the common idioms (`>`, `tee`,
`sed -i`, `perl -pi`, `cat <<EOF`, `.write_text(`, `open(..., 'w')`), but a helper