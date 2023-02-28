#!/usr/bin/env node
import { auditAgentLoops } from '../src/analyzer.mjs';

const report = auditAgentLoops(process.argv.slice(2));

console.log(`loopbrake: scanned ${report.sessionsScanned} session(s)`);
console.log(`edit calls: ${report.editCalls}`);
console.log(`thrashed source files: ${report.thrashedFiles.length}`);
console.log('');

if (report.thrashedFiles.length === 0) {
  console.log('No edit thrashing found.');
} else {
  for (const tf of report.thrashedFiles) {
    console.log(`${tf.edits}x ${tf.file} (${tf.session}) via ${tf.methods.join(', ')}`);
  }
}
