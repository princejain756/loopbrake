#!/usr/bin/env node
import { auditAgentLoops } from '../src/analyzer.mjs';

const report = auditAgentLoops(process.argv.slice(2));

console.log(`loopbrake: scanned ${report.sessionsScanned} session(s)`);
console.log(`structured edit calls: ${report.metrics.structuredEditCalls}`);
console.log(`thrashed source files: ${report.metrics.thrashedFileCount}`);
console.log('');

for (const tf of report.thrashedFiles) {
  console.log(`${tf.edits}x ${tf.file} (${tf.session}) via ${tf.methods.join(', ')}`);
}

if (report.findings.length === 0) {
  console.log('No edit thrashing found.');
} else {
  console.log('');
  for (const f of report.findings) {
    console.log(`${f.severity} ${f.ruleId} ${f.file}: ${f.detail}`);
  }
}
