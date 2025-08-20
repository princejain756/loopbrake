// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditAgentLoops } from '../src/analyzer.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loopbrake-test-'));
}

function writeSession(dir, name, rows) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n'));
  return p;
}

function editRow(id, file, oldStr, newStr) {
  return {
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Edit',
          input: { file_path: file, old_string: oldStr, new_string: newStr }
        }
      ]
    }
  };
}

function bashRow(id, command) {
  return {
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }]
    }
  };
}

test('1. Detects same-file edit thrashing (LPB001) and band-aid patching (LPB002)', () => {
  const tmp = makeTempDir();
  writeSession(tmp, 'session-thrash.jsonl', [
    editRow(
      'tu_fno_1',
      '/repo/src/fno.py',
      'const timeoutMs = 1000; // default timeout',
      'const timeoutMs = 2500; // patched timeout value'
    ),
    editRow(
      'tu_fno_2',
      '/repo/src/fno.py',
      'const timeoutMs = 2500; // patched timeout value',
      'const timeoutMs = 5000; // second bandaid patch'
    ),
    ...[3, 4].map((i) => editRow(`tu_fno_${i}`, '/repo/src/fno.py', `line_${i}`, `line_patched_${i}`)),
    ...[1, 2, 3].map((i) => editRow(`tu_mcx_${i}`, '/repo/src/mcx.py', `a_${i}`, `b_${i}`))
  ]);

  const res = auditAgentLoops([tmp]);
  assert.ok(res.ruleCounts.LPB001 >= 1, 'Expected LPB001 critical edit thrash on fno.py');
  assert.ok(res.ruleCounts.LPB002 >= 1, 'Expected LPB002 band-aid threshold on mcx.py');
  assert.ok(res.ruleCounts.LPB003 >= 1, 'Expected LPB003 overlapping hunk rewrite on fno.py');
  assert.equal(res.metrics.thrashedFileCount, 2, 'Expected both files reported as thrashed');
  assert.ok(res.score < 100, 'Overlap and thrash findings must reduce the score');
});

test('2. Filters README.md and package.json churn out of thrash counts (LPB007)', () => {
  const tmp = makeTempDir();
  writeSession(tmp, 'session-docs.jsonl', [
    ...[1, 2, 3, 4].map((i) => editRow(`tu_readme_${i}`, '/repo/README.md', `v${i}`, `v${i + 1}`)),
    ...[1, 2, 3].map((i) => editRow(`tu_pkg_${i}`, '/repo/package.json', `"a": ${i}`, `"a": ${i + 1}`))
  ]);

  const res = auditAgentLoops([tmp]);
  assert.equal(res.metrics.thrashedFileCount, 0, 'Docs and manifests must not be thrashed files');
  assert.equal(res.metrics.docManifestFilteredCount, 7, 'Expected 7 doc/manifest edits filtered');
  assert.ok(res.ruleCounts.LPB007 >= 1, 'Expected LPB007 doc/manifest filter summary');
});
