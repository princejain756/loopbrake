#!/usr/bin/env node
import { auditAgentLoops, getDemoResult, RULE_META } from '../src/analyzer.mjs';

function renderReport(report) {
  const { findings, ruleCounts, thrashedFiles, metrics } = report;

  console.log('');
  console.log(`loopbrake — ${report.sessionsScanned} session(s) scanned`);
  console.log(`loop-safety score: ${report.score}/100 (${report.grade})`);
  console.log(`structured edits: ${metrics.structuredEditCalls}`);
  console.log(`thrashed source files: ${metrics.thrashedFileCount}`);
  console.log(`overlapping hunks: ${metrics.sameTargetOverlapCount}`);
  console.log(`doc/manifest edits excluded: ${metrics.docManifestFilteredCount}`);
  console.log(`failed tool calls: ${metrics.totalErrors} (longest streak ${metrics.maxErrorStreak})`);
  console.log(`deleted-sandbox cwd escapes: ${metrics.cwdEscapeCount}`);
  console.log(`identical command retries: ${metrics.commandRetryLoops} (${metrics.wastedRetryCalls} wasted calls)`);
  console.log(`empty write_stdin poll spins: ${metrics.emptyStdinPollSessions}`);
  console.log(`unique tool calls: ${report.deduplicatedCalls}`);
  console.log(`shell-write bypasses: ${metrics.shellMutationCalls} (${metrics.shellBypassPct}%)`);
  console.log('');

  if (thrashedFiles.length > 0) {
    console.log('THRASHED SOURCE FILES (3+ MUTATIONS IN ONE SESSION)');
    for (const tf of thrashedFiles) {
      console.log(`  ${String(tf.edits).padStart(2, ' ')}x  ${tf.file}  (${tf.session})  via ${tf.methods.join(', ')}`);
    }
    console.log('');
  }

  if (findings.length === 0) {
    console.log('No edit thrashing found.');
    return;
  }

  console.log('RULE BREAKDOWN');
  for (const meta of Object.values(RULE_META)) {
    const count = ruleCounts[meta.id] || 0;
    if (count === 0) continue;
    console.log(`  ${meta.severity.padEnd(8, ' ')}  ${meta.id}  ${count}x  ${meta.title}`);
  }
  console.log('');

  for (const f of findings.slice(0, 10)) {
    console.log(`${f.severity}  ${f.ruleId}  ${f.file}: ${f.detail}`);
    console.log(`        evidence: ${f.evidence}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const demoMode = args.includes('--demo');
  const targetPaths = args.filter((a) => !a.startsWith('-'));

  const report = demoMode
    ? getDemoResult()
    : targetPaths.length > 0
      ? auditAgentLoops(targetPaths)
      : auditAgentLoops();

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderReport(report);
  }
}

main();