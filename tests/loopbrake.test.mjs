import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditAgentLoops } from '../src/analyzer.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loopbrake-test-'));
}

test('1. Detects same-file edit thrashing (LPB001)', () => {
  const tmp = makeTempDir();
  const logPath = path.join(tmp, 'session-thrash.jsonl');
  const rows = [1, 2, 3, 4, 5].map((i) => ({
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
  }));
  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n'));

  const res = auditAgentLoops([tmp]);
  assert.ok(res.ruleCounts.LPB001 >= 1, 'Expected LPB001 critical edit thrash on fno.py');
  assert.equal(res.metrics.thrashedFileCount, 1, 'Expected exactly one thrashed file');
});
