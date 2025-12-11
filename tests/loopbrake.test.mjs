import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditAgentLoops,
  generateCircuitBreakerHook,
  getDemoResult
} from '../src/analyzer.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loopbrake-test-'));
}

test('1. Detects same-file edit thrashing (LPB001/LPB002/LPB003) while filtering README.md and package.json (LPB007)', () => {
  const tmp = makeTempDir();
  const logPath = path.join(tmp, 'session-thrash.jsonl');
  const rows = [
    // 5 edits on src/fno.py with overlapping old_string/new_string -> LPB001 + LPB003
    {
      type: 'assistant',
      message: {
        id: 'msg_fno_1',
        content: [
          {
            type: 'tool_use',
            id: 'tu_fno_1',
            name: 'Edit',
            input: {
              file_path: '/repo/src/fno.py',
              old_string: 'const timeoutMs = 1000; // default timeout',
              new_string: 'const timeoutMs = 2500; // patched timeout value'
            }
          }
        ]
      }
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_fno_2',
        content: [
          {
            type: 'tool_use',
            id: 'tu_fno_2',
            name: 'Edit',
            input: {
              file_path: '/repo/src/fno.py',
              old_string: 'const timeoutMs = 2500; // patched timeout value',
              new_string: 'const timeoutMs = 5000; // second bandaid patch'
            }
          }
        ]
      }
    },
    ...[3, 4, 5].map((i) => ({
      type: 'assistant',
      message: {
        id: `msg_fno_${i}`,
        content: [
          {
            type: 'tool_use',
            id: `tu_fno_${i}`,
            name: 'Edit',
            input: {
              file_path: '/repo/src/fno.py',
              old_string: `line_${i}`,
              new_string: `line_patched_${i}`
            }
          }
        ]
      }
    })),
    // 4 edits on README.md -> should be filtered as doc/manifest updates (LPB007)
    ...[1, 2, 3, 4].map((i) => ({
      type: 'assistant',
      message: {
        id: `msg_readme_${i}`,
        content: [
          {
            type: 'tool_use',
            id: `tu_readme_${i}`,
            name: 'Edit',
            input: {
              file_path: '/repo/README.md',
              old_string: `v${i}`,
              new_string: `v${i + 1}`
            }
          }
        ]
      }
    }))
  ];
  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n'));

  const res = auditAgentLoops([tmp]);
  assert.ok(res.ruleCounts.LPB001 >= 1, 'Expected LPB001 critical edit thrash on fno.py');
  assert.ok(res.ruleCounts.LPB003 >= 1, 'Expected LPB003 overlapping hunk rewrite on fno.py');
  assert.equal(res.metrics.docManifestFilteredCount, 4, 'Expected 4 README.md edits filtered');
  assert.ok(res.ruleCounts.LPB007 >= 1, 'Expected LPB007 doc/manifest filter summary');
});

test('2. Detects shell-write bypasses (LPB004) while filtering read-only python3 -c inspections (LPB006) and .jsonl vs .js collisions', () => {
  const tmp = makeTempDir();
  const logPath = path.join(tmp, 'session-bypass.jsonl');
  const rows = [
    // 4 shell rewrites of src/brain.py via heredoc -> LPB004 + LPB001
    ...[1, 2, 3, 4].map((i) => ({
      type: 'assistant',
      message: {
        id: `msg_sh_${i}`,
        content: [
          {
            type: 'tool_use',
            id: `tu_sh_${i}`,
            name: 'Bash',
            input: {
              command: `cat <<'EOF' > src/brain.py\nprint(${i})\nEOF`
            }
          }
        ]
      }
    })),
    // Read-only python3 -c inspection referencing submission.py and data/journal.jsonl -> LPB006 + LPB007 guard
    {
      type: 'assistant',
      message: {
        id: 'msg_ro_1',
        content: [
          {
            type: 'tool_use',
            id: 'tu_ro_1',
            name: 'Bash',
            input: {
              command: `python3 -c "import json; print(open('submission.py').read()[:80]); rows=open('data/journal.jsonl').readlines()"`
            }
          }
        ]
      }
    }
  ];
  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n'));

  const res = auditAgentLoops([tmp]);
  assert.equal(res.metrics.shellMutationCalls, 4, 'Expected 4 shell-write bypasses');
  assert.ok(res.ruleCounts.LPB004 >= 1, 'Expected LPB004 finding on brain.py');
  assert.equal(res.metrics.readOnlyPythonOrSedCount, 1, 'Expected read-only python3 -c inspection filtered');
  assert.ok(res.metrics.jsonlPrefixCollisionCount >= 1, 'Expected .jsonl vs .js prefix collision avoided');
  const falseSubmission = res.findings.find(
    (f) => (f.ruleId === 'LPB001' || f.ruleId === 'LPB002') && f.detail.includes('submission.py')
  );
  assert.equal(falseSubmission, undefined, 'Read-only python3 -c inspection must not count as edit thrashing');
});

test('3. Detects consecutive tool-error doom loops (LPB008) and deleted-sandbox CWD escape to home directory (LPB010)', () => {
  const tmp = makeTempDir();
  const logPath = path.join(tmp, 'session-doom.jsonl');
  const rows = [];

  // 9 consecutive failed Skill calls ("pony tail")
  for (let i = 1; i <= 9; i++) {
    rows.push({
      type: 'assistant',
      message: {
        id: `msg_err_${i}`,
        content: [
          {
            type: 'tool_use',
            id: `tu_err_${i}`,
            name: 'Skill',
            input: { skill: 'pony tail' }
          }
        ]
      }
    });
    rows.push({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: `tu_err_${i}`,
            is_error: true,
            content: '<tool_use_error>Unknown skill: pony tail. Did you mean ponytail?</tool_use_error>'
          }
        ]
      }
    });
  }

  // Deleted-sandbox CWD escape to home directory
  rows.push({
    type: 'assistant',
    message: {
      id: 'msg_cwd_1',
      content: [
        {
          type: 'tool_use',
          id: 'tu_cwd_1',
          name: 'Bash',
          input: { command: 'rg --files' }
        }
      ]
    }
  });
  rows.push({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_cwd_1',
          is_error: true,
          content: 'Working directory "/private/tmp/worktree-99" was deleted; shell cwd recovered to /Users/princejain756'
        }
      ]
    }
  });

  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n'));
  const res = auditAgentLoops([tmp]);
  assert.ok(res.ruleCounts.LPB008 >= 1, 'Expected LPB008 critical consecutive tool-error doom loop');
  assert.equal(res.metrics.maxErrorStreak, 10, 'Expected streak of 10 consecutive failed calls');
  assert.ok(res.ruleCounts.LPB010 >= 1, 'Expected LPB010 deleted-sandbox CWD escape finding');
});

test('4. Detects identical shell command retry loops (LPB011), empty write_stdin polling spin (LPB012), and deduplicates streaming tool_use ids (LPB014)', () => {
  const tmp = makeTempDir();
  const logPath = path.join(tmp, 'session-spin.jsonl');
  const rows = [
    // Duplicate streaming rows with identical tool_use id
    {
      type: 'assistant',
      message: {
        id: 'msg_dup',
        content: [{ type: 'tool_use', id: 'tu_same_1', name: 'Bash', input: { command: 'pytest -q' } }]
      }
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_dup',
        content: [{ type: 'tool_use', id: 'tu_same_1', name: 'Bash', input: { command: 'pytest -q' } }]
      }
    },
    // Identical command retried 3 more times
    ...[2, 3, 4].map((i) => ({
      type: 'assistant',
      message: {
        id: `msg_retry_${i}`,
        content: [{ type: 'tool_use', id: `tu_same_${i}`, name: 'Bash', input: { command: 'pytest -q' } }]
      }
    })),
    // 5 empty write_stdin polls
    ...[1, 2, 3, 4, 5].map((i) => ({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: `call_poll_${i}`,
        name: 'write_stdin',
        arguments: JSON.stringify({ session_id: 11, chars: '' })
      }
    }))
  ];

  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n'));
  const res = auditAgentLoops([tmp]);
  assert.equal(res.deduplicatedCalls, 9, 'Expected 9 unique calls after skipping 1 duplicate streaming row');
  assert.ok(res.ruleCounts.LPB011 >= 1, 'Expected LPB011 identical command retry loop');
  assert.ok(res.ruleCounts.LPB012 >= 1, 'Expected LPB012 empty write_stdin polling spin');
  assert.ok(res.ruleCounts.LPB014 >= 1, 'Expected LPB014 deduplication info finding');
});

test('5. Generates deterministic circuit-breaker hook and returns verified 153-session demo benchmark', () => {
  const hook = generateCircuitBreakerHook();
  assert.ok(hook.hookScript.includes('CIRCUIT BREAKER'));
  assert.ok(hook.settingsSnippet.hooks.PreToolUse.length > 0);
  assert.ok(hook.settingsSnippet.hooks.PostToolUse.length > 0);

  const demo = getDemoResult();
  assert.equal(demo.sessionsScanned, 153);
  assert.equal(demo.metrics.shellBypassPct, 39.2);
  assert.equal(demo.metrics.maxErrorStreak, 9);
});
