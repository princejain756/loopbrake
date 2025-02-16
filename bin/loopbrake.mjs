#!/usr/bin/env node
import {
  auditAgentLoops,
  generateCircuitBreakerHook,
  getDemoResult,
  RULE_META
} from '../src/analyzer.mjs';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const SEV_RANK = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function colorSeverity(sev) {
  const s = String(sev || '').toUpperCase();
  if (s === 'CRITICAL') return `${COLORS.red}${COLORS.bold}CRITICAL${COLORS.reset}`;
  if (s === 'HIGH') return `${COLORS.red}HIGH    ${COLORS.reset}`;
  if (s === 'MEDIUM') return `${COLORS.yellow}MEDIUM  ${COLORS.reset}`;
  if (s === 'LOW') return `${COLORS.cyan}LOW     ${COLORS.reset}`;
  return `${COLORS.gray}INFO    ${COLORS.reset}`;
}

function colorGrade(grade) {
  if (grade.startsWith('A')) return `${COLORS.green}${COLORS.bold}${grade}${COLORS.reset}`;
  if (grade.startsWith('B')) return `${COLORS.cyan}${COLORS.bold}${grade}${COLORS.reset}`;
  if (grade.startsWith('C')) return `${COLORS.yellow}${COLORS.bold}${grade}${COLORS.reset}`;
  return `${COLORS.red}${COLORS.bold}${grade}${COLORS.reset}`;
}

function printHelp() {
  console.log(`
${COLORS.bold}loopbrake${COLORS.reset} — Detect and break agent edit-thrashing, shell-write bypasses & doom loops

${COLORS.bold}USAGE${COLORS.reset}
  npx loopbrake [paths...] [options]

${COLORS.bold}OPTIONS${COLORS.reset}
  --demo                 Run deterministic benchmark showcase (153 Claude Code & Codex transcripts)
  --emit-hook            Print ready-to-install Claude Code PreToolUse/PostToolUse circuit-breaker hook
  --json                 Output structured JSON report for CI / agent gates
  --fail-on <severity>   Exit code 1 if any finding >= severity (low|medium|high|critical)
  -h, --help             Show this help message
  -v, --version          Show version

${COLORS.bold}EXAMPLES${COLORS.reset}
  npx loopbrake ~/.claude/projects ~/.codex/sessions
  npx loopbrake --demo
  npx loopbrake --emit-hook
  npx loopbrake ./logs --fail-on high --json
`);
}

function renderReport(report) {
  const { metrics, findings, ruleCounts, thrashedFiles } = report;
  const line = '─'.repeat(86);

  console.log(`\n${COLORS.bold}${COLORS.cyan}╭${line}╮${COLORS.reset}`);
  console.log(
    `${COLORS.bold}${COLORS.cyan}│${COLORS.reset} ${COLORS.bold}LOOPBRAKE v0.1.0${COLORS.reset}  ${COLORS.dim}Agent Edit-Thrash, Shell-Write Bypass & Doom-Loop Auditor${COLORS.reset}         ${COLORS.bold}${COLORS.cyan}│${COLORS.reset}`
  );
  console.log(`${COLORS.bold}${COLORS.cyan}╰${line}╯${COLORS.reset}`);

  const totalWrites = metrics.structuredEditCalls + metrics.shellMutationCalls;
  console.log(
    `  ${COLORS.bold}Loop-Safety Score:${COLORS.reset} ${COLORS.bold}${report.score}/100${COLORS.reset} (${colorGrade(report.grade)})   ` +
      `${COLORS.bold}Sessions:${COLORS.reset} ${report.sessionsScanned}   ` +
      `${COLORS.bold}Unique Tool Calls:${COLORS.reset} ${report.deduplicatedCalls.toLocaleString()}`
  );
  console.log(
    `  ${COLORS.bold}File Mutations:${COLORS.reset} ${totalWrites} total   ` +
      `${COLORS.cyan}Structured (Edit/Write/Patch):${COLORS.reset} ${metrics.structuredEditCalls}   ` +
      `${COLORS.yellow}Shell-Write Bypasses:${COLORS.reset} ${metrics.shellMutationCalls} (${metrics.shellBypassPct}%)`
  );
  console.log(
    `  ${COLORS.bold}Thrashed Files (>=3x):${COLORS.reset} ${metrics.thrashedFileCount}   ` +
      `${COLORS.bold}Failed Tool Calls:${COLORS.reset} ${metrics.totalErrors}   ` +
      `${COLORS.bold}Error Streaks:${COLORS.reset} ${metrics.consecutiveErrorStreaks} (max ${metrics.maxErrorStreak}x)   ` +
      `${COLORS.bold}CWD Escapes:${COLORS.reset} ${metrics.cwdEscapeCount}`
  );
  console.log(
    `  ${COLORS.bold}False-Positive Guards:${COLORS.reset} ` +
      `${COLORS.green}${metrics.readOnlyPythonOrSedCount} read-only python/sed inspections${COLORS.reset} · ` +
      `${COLORS.green}${metrics.docManifestFilteredCount} doc/manifest updates${COLORS.reset} · ` +
      `${COLORS.green}${metrics.jsonlPrefixCollisionCount} .jsonl/.js prefix guards${COLORS.reset}\n`
  );

  if (thrashedFiles && thrashedFiles.length > 0) {
    console.log(`${COLORS.bold}  THRASHED SOURCE FILES (>= 3 MUTATIONS IN ONE SESSION)${COLORS.reset}`);
    console.log(`  ${COLORS.dim}${line}${COLORS.reset}`);
    for (const tf of thrashedFiles.slice(0, 5)) {
      console.log(
        `  ${COLORS.red}${COLORS.bold}${String(tf.edits).padStart(2, ' ')}x${COLORS.reset}  ${COLORS.cyan}${tf.file.padEnd(28)}${COLORS.reset} ${COLORS.dim}session:${COLORS.reset} ${tf.session.padEnd(26)} ${COLORS.yellow}via ${tf.methods.join(', ')}${COLORS.reset}`
      );
    }
    console.log('');
  }

  console.log(`${COLORS.bold}  RULE BREAKDOWN${COLORS.reset}`);
  console.log(`  ${COLORS.dim}${line}${COLORS.reset}`);
  for (const r of Object.values(RULE_META)) {
    const count = ruleCounts[r.id] || 0;
    if (count === 0) continue;
    const countStr = String(count).padStart(4, ' ');
    console.log(
      `  ${colorSeverity(r.severity)}  ${COLORS.bold}${r.id}${COLORS.reset}  ${countStr}x  ${r.title}`
    );
  }

  console.log(`\n${COLORS.bold}  TOP EDIT-THRASH, SHELL-BYPASS & DOOM-LOOP FINDINGS${COLORS.reset}`);
  console.log(`  ${COLORS.dim}${line}${COLORS.reset}`);
  for (const f of findings.slice(0, 6)) {
    console.log(
      `  ${colorSeverity(f.severity)}  ${COLORS.bold}${f.ruleId}${COLORS.reset}  ${COLORS.cyan}${String(f.file).slice(0, 26).padEnd(26)}${COLORS.reset} ${f.detail}`
    );
    console.log(
      `            ${COLORS.dim}Evidence:${COLORS.reset} ${COLORS.yellow}${f.evidence}${COLORS.reset}`
    );
  }
  console.log(`  ${COLORS.dim}${line}${COLORS.reset}\n`);
}
