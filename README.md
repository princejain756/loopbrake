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

# Run the deterministic 153-session benchmark showcase
node ./bin/loopbrake.mjs --demo

# Machine-readable report for CI
node ./bin/loopbrake.mjs ./logs --json
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
| `LPB011` | `MEDIUM` | Loop | Identical shell command retried 3+ times back-to-back |
| `LPB012` | `MEDIUM` | Loop | 3+ empty `write_stdin` polls in one session |
| `LPB013` | `LOW` | Loop | Duplicate `Skill` re-invocation in the same session |
| `LPB014` | `INFO` | Guard | Streaming `tool_use.id` / `call_id` progress rows deduplicated |

## 153-Session Benchmark (`~/.claude/projects` + `~/.codex/sessions`)

The `--demo` dataset is baked into the source, so the numbers reproduce without
your own transcripts:

| Metric | Measured Value |
| :--- | ---: |
| Sessions scanned | `153` |
| Unique deduplicated tool calls | `2,581` |
| Structured file mutations (`Edit` / `Write` / `apply_patch`) | `121` |
| Shell-write bypasses (`Bash` / `codex:exec`) | `78` (`39.2%` of writes) |
| Source files thrashed (`>= 3` mutations in one session) | `5` |
| Read-only `python3 -c` / `sed -n` inspections filtered | `570` |
| Total failed tool calls / consecutive streaks | `178` / `18` |

## Installing the live circuit-breaker hook (`--emit-hook`)

Run `node ./bin/loopbrake.mjs --emit-hook` to print
`~/.claude/hooks/loopbrake-hook.mjs` and the matching `.claude/settings.json`
configuration. Unlike a basic `Edit`-only counter, the generated hook inspects
both structured `Edit`/`MultiEdit`/`Write` calls **and** `Bash` write operators
(`sed -i`, `cat <<`, `.write_text(`), tracks `PostToolUse` error streaks, and exits
with code `2` when a file hits 3 mutations or 3 consecutive tool errors, forcing
the agent to stop and state the root cause.

## Limitations

Shell-write parsing is heuristic. It recognises the common idioms (`>`, `tee`,
`sed -i`, `perl -pi`, `cat <<EOF`, `.write_text(`, `open(..., 'w')`), but a helper
binary or build script that rewrites sources without naming them on the command
line will not be attributed to a file.

## License

MIT © [Prince Jain](https://github.com/princejain756)
