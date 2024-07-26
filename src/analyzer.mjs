import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const RULE_META = {
  // Plane 1: File Edit Thrashing, Shell-Write Bypass & Patch Overlap
  LPB001: {
    id: "LPB001",
    plane: "thrash",
    severity: "CRITICAL",
    title: "Same-File Edit Thrashing (>= 4 Mutations to One File in a Single Session)",
    points: 25
  },
  LPB002: {
    id: "LPB002",
    plane: "thrash",
    severity: "HIGH",
    title: "Repeated Band-Aid Patching (3 Mutations to One File in a Single Session)",
    points: 12
  },
  LPB003: {
    id: "LPB003",
    plane: "thrash",
    severity: "HIGH",
    title: "Overlapping Hunk or Self-Revert Rewrite on Previously Patched Lines",
    points: 15
  },
  LPB004: {
    id: "LPB004",
    plane: "thrash",
    severity: "MEDIUM",
    title: "Shell-Write Bypass of Structured Edit/apply_patch Tools (cat <<EOF / sed -i / .write_text)",
    points: 8
  },
  LPB005: {
    id: "LPB005",
    plane: "thrash",
    severity: "MEDIUM",
    title: "Blind File Edit Invoked Before Any Read or Inspection of Target File",
    points: 8
  },
  LPB006: {
    id: "LPB006",
    plane: "thrash",
    severity: "INFO",
    title: "Read-Only python3 -c / sed -n AST & Log Inspections Separated (False-Positive Guard)",
    points: 0
  },
  LPB007: {
    id: "LPB007",
    plane: "thrash",
    severity: "INFO",
    title: "Prefix Extension Collisions (.jsonl vs .js) & Doc/Manifest Updates Filtered (False-Positive Guard)",
    points: 0
  },

  // Plane 2: Tool-Error Doom Loops, Deleted-Sandbox CWD Drift & Polling Spins
  LPB008: {
    id: "LPB008",
    plane: "loop",
    severity: "CRITICAL",
    title: "Severe Tool-Error Doom Loop (>= 4 Consecutive Failing Tool Calls)",
    points: 30
  },
  LPB009: {
    id: "LPB009",
    plane: "loop",
    severity: "HIGH",
    title: "Consecutive Tool-Error Streak (2 to 3 Consecutive Failing Tool Calls)",
    points: 10
  },
  LPB010: {
    id: "LPB010",
    plane: "loop",
    severity: "CRITICAL",
    title: "Deleted-Sandbox CWD Escape Recovering Shell into User Home Directory",
    points: 25
  },
  LPB011: {
    id: "LPB011",
    plane: "loop",
    severity: "MEDIUM",
    title: "Identical Shell Command Retry Loop (>= 3 Consecutive Identical Executions)",
    points: 10
  },
  LPB012: {
    id: "LPB012",
    plane: "loop",
    severity: "MEDIUM",
    title: "Empty write_stdin Polling Spin (>= 3 Empty Polls in One Session)",
    points: 8
  },
  LPB013: {
    id: "LPB013",
    plane: "loop",
    severity: "LOW",
    title: "Duplicate Skill Re-Invocation in Same Session",
    points: 4
  },
  LPB014: {
    id: "LPB014",
    plane: "loop",
    severity: "INFO",
    title: "Streaming tool_use.id / call_id Progress Rows Deduplicated (False-Positive Guard)",
    points: 0
  }
};

const SOURCE_FILE_RE = /\b([a-zA-Z0-9_.-]+\.(?:py|mjs|cjs|js|ts|tsx|jsx|rs|go|java|c|cpp|h|rb|php|swift|kt|sql|sh|css|html|vue|svelte))\b/g;
const DOC_OR_MANIFEST_RE = /^(?:README\.md|CHANGELOG\.md|LICENSE|package\.json|package-lock\.json|pnpm-lock\.yaml|Cargo\.toml|Cargo\.lock|pyproject\.toml)$/i;

export function maskHome(text) {
  if (!text) return "";
  return String(text)
    .replace(/\/Users\/[a-zA-Z0-9._-]+/g, "~")
    .replace(/\/home\/[a-zA-Z0-9._-]+/g, "~");
}

export function isShellFileWrite(cmd) {
  const s = String(cmd || "");
  if (!s) return false;
  if (/\b(?:sed\s+-i|perl\s+-pi|tee\s+|cat\s+<<|\.write_text\(|shutil\.copy)/i.test(s)) {
    return true;
  }
  if (/open\([^)]*,\s*["'][wa][b+]?["']\)/.test(s)) {
    return true;
  }
  if (/(?:^|[^\d>])>\s*[a-zA-Z0-9_./-]+\.(?:py|mjs|cjs|js|ts|tsx|jsx|rs|go|java|html|css|sh)\b/.test(s)) {
    return true;
  }
  return false;
}

export function extractTargetSourceFiles(cmd) {
  const s = String(cmd || "");
  const matches = [...s.matchAll(SOURCE_FILE_RE)].map((m) => path.basename(m[1]));
  return [...new Set(matches)].filter((f) => !DOC_OR_MANIFEST_RE.test(f));
}

export function analyzeSessionTranscript(filePath) {
  const findings = [];
  const sessionLabel = path.basename(filePath);
  const seenIds = new Set();
  let rawProgressRows = 0;
  let deduplicatedCalls = 0;
  let structuredEditCalls = 0;
  let shellMutationCalls = 0;
  let readOnlyPythonOrSedCount = 0;
  let jsonlPrefixCollisionCount = 0;
  let docManifestFilteredCount = 0;
  let blindEditCount = 0;
  let sameTargetOverlapCount = 0;
  let totalErrors = 0;
  let consecutiveErrorStreaks = 0;
  let maxErrorStreak = 0;
  let maxErrorSignature = "";
  let cwdEscapeCount = 0;
  let commandRetryLoops = 0;
  let wastedRetryCalls = 0;
  let emptyStdinPolls = 0;
  let duplicateSkillCalls = 0;

  const readFiles = new Set();
  const fileMutations = new Map(); // filename -> array of { method, oldStr, newStr }
  const skillsInvoked = new Map();
  const bashSeq = [];
  let currentErrorStreak = 0;
  let currentErrorSample = "";

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // 1. Claude Code assistant tool_use
    if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
      for (const blk of obj.message.content) {
        if (blk?.type !== "tool_use") continue;
        rawProgressRows++;
        if (blk.id && seenIds.has(blk.id)) continue;
        if (blk.id) seenIds.add(blk.id);
        deduplicatedCalls++;

        const name = String(blk.name || "");
        const input = blk.input || {};

        if (name === "Read") {
          const fp = path.basename(String(input.file_path || input.path || ""));
          if (fp) readFiles.add(fp);
        } else if (["Edit", "MultiEdit", "Write"].includes(name)) {
          const fp = path.basename(String(input.file_path || input.path || "unknown"));
          if (DOC_OR_MANIFEST_RE.test(fp)) {
            docManifestFilteredCount++;
            continue;
          }
          structuredEditCalls++;
          if (name !== "Write" && !readFiles.has(fp)) {
            blindEditCount++;
          }
          readFiles.add(fp);
          if (!fileMutations.has(fp)) fileMutations.set(fp, []);
          const edits =
            name === "MultiEdit" && Array.isArray(input.edits)
              ? input.edits
              : [{ old_string: input.old_string || "", new_string: input.new_string || input.content || "" }];
          for (const ed of edits) {
            fileMutations.get(fp).push({
              method: name,
              oldStr: String(ed.old_string || ""),
              newStr: String(ed.new_string || "")
            });
          }
        } else if (name === "Bash") {
          const cmd = String(input.command || "");
          if (/\.jsonl\b/.test(cmd)) jsonlPrefixCollisionCount++;
          const targets = extractTargetSourceFiles(cmd);
          if (/\b(?:cat|head|tail|sed\s+-n|grep|rg)\b/.test(cmd)) {
            for (const t of targets) readFiles.add(t);
          }
          if (isShellFileWrite(cmd) && targets.length > 0) {
            shellMutationCalls++;
            const target = targets[0];
            if (!fileMutations.has(target)) fileMutations.set(target, []);
            fileMutations.get(target).push({
              method: "BashWrite",
              oldStr: "",
              newStr: cmd.slice(0, 240)
            });
          } else if (targets.length > 0 && /\b(?:python3?\s+-c|sed\s+-n)\b/.test(cmd)) {
            readOnlyPythonOrSedCount++;
          }
          bashSeq.push(cmd);
        } else if (name === "Skill") {
          const sk = String(input.skill || input.name || "unknown").trim();
          skillsInvoked.set(sk, (skillsInvoked.get(sk) || 0) + 1);
        }
      }
    }

    // 2. Claude Code user tool_result
    if (obj?.type === "user" && Array.isArray(obj?.message?.content)) {
      for (const blk of obj.message.content) {
        if (blk?.type !== "tool_result") continue;
        const txt = typeof blk.content === "string" ? blk.content : JSON.stringify(blk.content || "");
        if (/Working directory .* was deleted; shell cwd recovered to/i.test(txt)) {
          cwdEscapeCount++;
          findings.push({
            ruleId: "LPB010",
            plane: "loop",
            severity: "CRITICAL",
            file: sessionLabel,
            detail: `Deleted-sandbox CWD escape in ${sessionLabel}: shell recovered to user home directory mid-session`,
            evidence: maskHome(txt.slice(0, 160))
          });
        }

        const isErr =
          Boolean(blk.is_error) ||
          /Exit code [1-9]|Traceback \(most recent|SyntaxError:|ReferenceError:|TypeError:|Command failed|<tool_use_error>/i.test(
            txt
          );
        if (isErr) {
          totalErrors++;
          currentErrorStreak++;
          if (currentErrorStreak === 1) {
            currentErrorSample = maskHome(txt.replace(/\s+/g, " ").slice(0, 120));
          }
          if (currentErrorStreak === 2) {
            consecutiveErrorStreaks++;
          }
          if (currentErrorStreak > maxErrorStreak) {
            maxErrorStreak = currentErrorStreak;
            maxErrorSignature = currentErrorSample;
          }
        } else {
          currentErrorStreak = 0;
        }
      }
    }

    // 3. Codex CLI function_call / custom_tool_call
    if (
      obj?.type === "response_item" &&
      (obj?.payload?.type === "function_call" || obj?.payload?.type === "custom_tool_call")
    ) {
      rawProgressRows++;
      const id = obj.payload.call_id || obj.payload.id;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      deduplicatedCalls++;

      const name = String(obj.payload.name || "");
      const rawIn = String(obj.payload.input || obj.payload.arguments || "");

      if (/\.jsonl\b/.test(rawIn)) jsonlPrefixCollisionCount++;

      if (name === "apply_patch" || name === "write_file") {
        const rawTargets =
          name === "apply_patch"
            ? [...rawIn.matchAll(/\*\*\* (?:Update|Add) File: ([^\n]+)/g)].map((m) => path.basename(m[1].trim()))
            : extractTargetSourceFiles(rawIn);
        const targets = rawTargets.filter((f) => !DOC_OR_MANIFEST_RE.test(f));
        if (rawTargets.length > targets.length) {
          docManifestFilteredCount += rawTargets.length - targets.length;
        }
        if (targets.length > 0) {
          structuredEditCalls++;
          for (const fp of targets) {
            if (name === "apply_patch" && !readFiles.has(fp)) {
              blindEditCount++;
            }
            readFiles.add(fp);
            if (!fileMutations.has(fp)) fileMutations.set(fp, []);
            fileMutations.get(fp).push({
              method: name,
              oldStr: "",
              newStr: rawIn.slice(0, 260)
            });
          }
        }
      } else if (name === "exec" || name === "exec_command") {
        if (/write_stdin\(\{[^}]*chars:\s*""/.test(rawIn)) {
          emptyStdinPolls++;
        }
        const targets = extractTargetSourceFiles(rawIn);
        if (/\b(?:cat|head|tail|sed\s+-n|grep|rg)\b/.test(rawIn)) {
          for (const t of targets) readFiles.add(t);
        }
        if (isShellFileWrite(rawIn) && targets.length > 0) {
          shellMutationCalls++;
          const target = targets[0];
          if (!fileMutations.has(target)) fileMutations.set(target, []);
          fileMutations.get(target).push({
            method: `codex:${name}`,
            oldStr: "",
            newStr: rawIn.slice(0, 240)
          });
        } else if (targets.length > 0 && /\b(?:python3?\s+-c|sed\s+-n)\b/.test(rawIn)) {
          readOnlyPythonOrSedCount++;
        }
        bashSeq.push(rawIn);
      } else if (name === "write_stdin") {
        try {
          const parsed = JSON.parse(rawIn);
          if (!parsed.chars) emptyStdinPolls++;
        } catch {
          // ignore
        }
      }
    }

    // 4. Codex CLI outputs
    if (
      obj?.type === "response_item" &&
      (obj?.payload?.type === "function_call_output" || obj?.payload?.type === "custom_tool_call_output")
    ) {
      const rawOut = obj.payload.output;
      const txt = typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut || "");
      const exitMatch = txt.match(/(?:Process exited with code|Exit code:?|exit_code":)\s*([1-9]\d*)/i);
      const hasFatal = /Traceback \(most recent|SyntaxError:|ReferenceError:|TypeError:|verification failed/i.test(txt);
      if (exitMatch || hasFatal) {
        totalErrors++;
        currentErrorStreak++;
        if (currentErrorStreak === 1) {
          currentErrorSample = maskHome(txt.replace(/\s+/g, " ").slice(0, 120));
        }
        if (currentErrorStreak === 2) {
          consecutiveErrorStreaks++;
        }
        if (currentErrorStreak > maxErrorStreak) {
          maxErrorStreak = currentErrorStreak;
          maxErrorSignature = currentErrorSample;
        }
      } else {
        currentErrorStreak = 0;
      }
    }
  }

  // Evaluate per-file edit thrashing & overlapping hunks
  const thrashedFiles = [];
  for (const [fp, list] of fileMutations.entries()) {
    if (list.length >= 4) {
      thrashedFiles.push({ file: fp, edits: list.length, methods: [...new Set(list.map((x) => x.method))] });
      findings.push({
        ruleId: "LPB001",
        plane: "thrash",
        severity: "CRITICAL",
        file: sessionLabel,
        detail: `${fp} mutated ${list.length} times in ${sessionLabel} via ${[...new Set(list.map((x) => x.method))].join(", ")}`,
        evidence: `${fp}: ${list.length} mutations`
      });
    } else if (list.length === 3) {
      thrashedFiles.push({ file: fp, edits: list.length, methods: [...new Set(list.map((x) => x.method))] });
      findings.push({
        ruleId: "LPB002",
        plane: "thrash",
        severity: "HIGH",
        file: sessionLabel,
        detail: `${fp} patched 3 times in ${sessionLabel} via ${[...new Set(list.map((x) => x.method))].join(", ")} (band-aid threshold)`,
        evidence: `${fp}: 3 mutations`
      });
    }

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.newStr || a.newStr.length < 15) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.oldStr || b.oldStr.length < 15) continue;
        const prefixA = a.newStr.slice(0, Math.min(50, a.newStr.length));
        const prefixB = b.oldStr.slice(0, Math.min(50, b.oldStr.length));
        if (b.oldStr.includes(prefixA) || a.newStr.includes(prefixB)) {
          sameTargetOverlapCount++;
          findings.push({
            ruleId: "LPB003",
            plane: "thrash",
            severity: "HIGH",
            file: sessionLabel,
            detail: `Edit #${j + 1} on ${fp} in ${sessionLabel} overwrote or reverted lines introduced by Edit #${i + 1}`,
            evidence: `${fp}: overlapping hunk rewrite`
          });
          break;
        }
      }
    }
  }

  // Evaluate consecutive shell command retry loops
  const normCmd = (c) => String(c || "").replace(/\s+/g, " ").trim().slice(0, 90);
  let cmdStreak = 1;
  for (let i = 1; i < bashSeq.length; i++) {
    const prev = normCmd(bashSeq[i - 1]);
    const cur = normCmd(bashSeq[i]);
    if (cur && cur === prev) {
      cmdStreak++;
      if (cmdStreak === 3) {
        commandRetryLoops++;
        findings.push({
          ruleId: "LPB011",
          plane: "loop",
          severity: "MEDIUM",
          file: sessionLabel,
          detail: `Identical shell command executed >= 3 times consecutively in ${sessionLabel}`,
          evidence: maskHome(cur.slice(0, 100))
        });
      }
      if (cmdStreak >= 3) {
        wastedRetryCalls++;
      }
    } else {
      cmdStreak = 1;
    }
  }

  if (maxErrorStreak >= 4) {
    findings.push({
      ruleId: "LPB008",
      plane: "loop",
      severity: "CRITICAL",
      file: sessionLabel,
      detail: `${maxErrorStreak} consecutive failing tool calls in ${sessionLabel} (${maxErrorSignature})`,
      evidence: maxErrorSignature
    });
  } else if (maxErrorStreak >= 2) {
    findings.push({
      ruleId: "LPB009",
      plane: "loop",
      severity: "HIGH",
      file: sessionLabel,
      detail: `${maxErrorStreak} consecutive failing tool calls in ${sessionLabel}`,
      evidence: maxErrorSignature
    });
  }

  if (emptyStdinPolls >= 3) {
    findings.push({
      ruleId: "LPB012",
      plane: "loop",
      severity: "MEDIUM",
      file: sessionLabel,
      detail: `${emptyStdinPolls} empty write_stdin polling calls in ${sessionLabel}`,
      evidence: `write_stdin empty polls: ${emptyStdinPolls}`
    });
  }

  for (const [sk, count] of skillsInvoked.entries()) {
    if (count >= 2) {
      duplicateSkillCalls += count - 1;
      findings.push({
        ruleId: "LPB013",
        plane: "loop",
        severity: "LOW",
        file: sessionLabel,
        detail: `Skill "${sk}" invoked ${count} times inside ${sessionLabel}`,
        evidence: `Skill: ${sk} (${count}x)`
      });
    }
  }

  return {
    findings,
    rawProgressRows,
    deduplicatedCalls,
    structuredEditCalls,
    shellMutationCalls,
    readOnlyPythonOrSedCount,
    jsonlPrefixCollisionCount,
    docManifestFilteredCount,
    blindEditCount,
    sameTargetOverlapCount,
    totalErrors,
    consecutiveErrorStreaks,
    maxErrorStreak,
    cwdEscapeCount,
    commandRetryLoops,
    wastedRetryCalls,
    emptyStdinPolls,
    duplicateSkillCalls,
    thrashedFiles
  };
}

function collectJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectJsonlFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  } catch {
    // ignore
  }
  return out;
}

export function auditAgentLoops(options = {}) {
  let transcriptFiles;
  if (Array.isArray(options)) {
    transcriptFiles = [];
    for (const p of options) {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (st.isDirectory()) collectJsonlFiles(p, transcriptFiles);
      else if (st.isFile() && p.endsWith(".jsonl")) transcriptFiles.push(p);
    }
  } else {
    const home = options.homeDir || os.homedir();
    transcriptFiles =
      options.transcriptFiles || [
        ...collectJsonlFiles(path.join(home, ".claude", "projects")),
        ...collectJsonlFiles(path.join(home, ".codex", "sessions"))
      ];
  }

  const allFindings = [];
  let rawProgressRows = 0;
  let deduplicatedCalls = 0;
  let structuredEditCalls = 0;
  let shellMutationCalls = 0;
  let readOnlyPythonOrSedCount = 0;
  let jsonlPrefixCollisionCount = 0;
  let docManifestFilteredCount = 0;
  let blindEditCount = 0;
  let sameTargetOverlapCount = 0;
  let totalErrors = 0;
  let consecutiveErrorStreaks = 0;
  let maxErrorStreak = 0;
  let cwdEscapeCount = 0;
  let commandRetryLoops = 0;
  let wastedRetryCalls = 0;
  let emptyStdinPollSessions = 0;
  let duplicateSkillCalls = 0;
  const allThrashedFiles = [];

  for (const tf of transcriptFiles) {
    try {
      const res = analyzeSessionTranscript(tf);
      allFindings.push(...res.findings);
      rawProgressRows += res.rawProgressRows;
      deduplicatedCalls += res.deduplicatedCalls;
      structuredEditCalls += res.structuredEditCalls;
      shellMutationCalls += res.shellMutationCalls;
      readOnlyPythonOrSedCount += res.readOnlyPythonOrSedCount;
      jsonlPrefixCollisionCount += res.jsonlPrefixCollisionCount;
      docManifestFilteredCount += res.docManifestFilteredCount;
      blindEditCount += res.blindEditCount;
      sameTargetOverlapCount += res.sameTargetOverlapCount;
      totalErrors += res.totalErrors;
      consecutiveErrorStreaks += res.consecutiveErrorStreaks;
      if (res.maxErrorStreak > maxErrorStreak) maxErrorStreak = res.maxErrorStreak;
      cwdEscapeCount += res.cwdEscapeCount;
      commandRetryLoops += res.commandRetryLoops;
      wastedRetryCalls += res.wastedRetryCalls;
      if (res.emptyStdinPolls >= 3) emptyStdinPollSessions++;
      duplicateSkillCalls += res.duplicateSkillCalls;
      for (const item of res.thrashedFiles) {
        allThrashedFiles.push({ session: path.basename(tf), ...item });
      }
    } catch {
      // ignore unreadable file
    }
  }

  if (shellMutationCalls > 0) {
    const pct = Math.round((shellMutationCalls / Math.max(1, structuredEditCalls + shellMutationCalls)) * 1000) / 10;
    allFindings.push({
      ruleId: "LPB004",
      plane: "thrash",
      severity: "MEDIUM",
      file: "session-transcripts",
      detail: `${shellMutationCalls} source file mutation(s) (${pct}% of all writes) executed via shell heredoc/sed/.write_text, bypassing structured Edit hooks`,
      evidence: `${shellMutationCalls} shell writes vs ${structuredEditCalls} Edit/Write/apply_patch calls`
    });
  }

  if (blindEditCount > 0) {
    allFindings.push({
      ruleId: "LPB005",
      plane: "thrash",
      severity: "MEDIUM",
      file: "session-transcripts",
      detail: `${blindEditCount} Edit/apply_patch call(s) modified a source file before any Read/cat inspection in the session`,
      evidence: `${blindEditCount} blind edits`
    });
  }

  if (readOnlyPythonOrSedCount > 0) {
    allFindings.push({
      ruleId: "LPB006",
      plane: "thrash",
      severity: "INFO",
      file: "session-transcripts",
      detail: `${readOnlyPythonOrSedCount} read-only python3 -c / sed -n code inspections separated from true file mutations`,
      evidence: `${readOnlyPythonOrSedCount} read-only inspections excluded`
    });
  }

  if (jsonlPrefixCollisionCount > 0 || docManifestFilteredCount > 0) {
    allFindings.push({
      ruleId: "LPB007",
      plane: "thrash",
      severity: "INFO",
      file: "session-transcripts",
      detail: `${jsonlPrefixCollisionCount} .jsonl-vs-.js prefix collision(s) and ${docManifestFilteredCount} doc/manifest edit(s) excluded from source thrash counts`,
      evidence: `${jsonlPrefixCollisionCount} .jsonl collisions, ${docManifestFilteredCount} doc/manifest updates`
    });
  }

  if (deduplicatedCalls > 0) {
    allFindings.push({
      ruleId: "LPB014",
      plane: "loop",
      severity: "INFO",
      file: "session-transcripts",
      detail: `${deduplicatedCalls} unique tool calls analyzed across ${transcriptFiles.length} sessions`,
      evidence: `${deduplicatedCalls} deduplicated calls`
    });
  }

  const ruleCounts = {};
  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of allFindings) {
    ruleCounts[f.ruleId] = (ruleCounts[f.ruleId] || 0) + 1;
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  let penalty = 0;
  for (const [ruleId, count] of Object.entries(ruleCounts)) {
    const meta = RULE_META[ruleId];
    if (!meta || meta.points === 0) continue;
    penalty += Math.min(meta.points * 2, meta.points * Math.sqrt(count));
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const grade =
    score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";

  const totalWrites = structuredEditCalls + shellMutationCalls;
  const shellBypassPct = totalWrites > 0 ? Math.round((shellMutationCalls / totalWrites) * 1000) / 10 : 0;

  return {
    sessionsScanned: transcriptFiles.length,
    deduplicatedCalls,
    score,
    grade,
    severityCounts,
    ruleCounts,
    metrics: {
      structuredEditCalls,
      shellMutationCalls,
      shellBypassPct,
      readOnlyPythonOrSedCount,
      jsonlPrefixCollisionCount,
      docManifestFilteredCount,
      blindEditCount,
      sameTargetOverlapCount,
      thrashedFileCount: allThrashedFiles.length,
      totalErrors,
      consecutiveErrorStreaks,
      maxErrorStreak,
      cwdEscapeCount,
      commandRetryLoops,
      wastedRetryCalls,
      emptyStdinPollSessions,
      duplicateSkillCalls
    },
    thrashedFiles: allThrashedFiles.sort((a, b) => b.edits - a.edits),
    findings: allFindings
  };
}

export function getDemoResult() {
  return {
    sessionsScanned: 153,
    deduplicatedCalls: 2581,
    score: 21,
    grade: "F",
    severityCounts: {
      CRITICAL: 10,
      HIGH: 14,
      MEDIUM: 25,
      LOW: 15,
      INFO: 3
    },
    ruleCounts: {
      LPB001: 2,
      LPB002: 3,
      LPB003: 2,
      LPB004: 1,
      LPB005: 1,
      LPB006: 1,
      LPB007: 1,
      LPB008: 6,
      LPB009: 9,
      LPB010: 2,
      LPB011: 20,
      LPB012: 3,
      LPB013: 15,
      LPB014: 1
    },
    metrics: {
      structuredEditCalls: 121,
      shellMutationCalls: 78,
      shellBypassPct: 39.2,
      readOnlyPythonOrSedCount: 570,
      jsonlPrefixCollisionCount: 207,
      docManifestFilteredCount: 11,
      blindEditCount: 15,
      sameTargetOverlapCount: 2,
      thrashedFileCount: 5,
      totalErrors: 178,
      consecutiveErrorStreaks: 18,
      maxErrorStreak: 9,
      cwdEscapeCount: 2,
      commandRetryLoops: 20,
      wastedRetryCalls: 48,
      emptyStdinPollSessions: 3,
      duplicateSkillCalls: 27
    },
    thrashedFiles: [
      { session: "rollout-01a1784f.jsonl", file: "fno.py", edits: 6, methods: ["apply_patch"] },
      { session: "rollout-01a12a24.jsonl", file: "brain.py", edits: 4, methods: ["codex:exec"] },
      { session: "rollout-01a12a24.jsonl", file: "test_backup_gdrive.py", edits: 3, methods: ["codex:exec"] },
      { session: "rollout-01a1784f.jsonl", file: "test_fno_exit_telemetry.py", edits: 3, methods: ["apply_patch"] },
      { session: "rollout-01a1784f.jsonl", file: "mcx.py", edits: 3, methods: ["apply_patch"] }
    ],
    findings: [
      {
        ruleId: "LPB008",
        plane: "loop",
        severity: "CRITICAL",
        file: "5f37b3d3-3d5e-40bc-9890-dc7bb86b1a3b.jsonl",
        detail: "9 consecutive failing tool calls in 5f37b3d3-3d5e-40bc-9890-dc7bb86b1a3b.jsonl (<tool_use_error>Unknown skill: pony tail. Did you mean ponytail?</tool_use_error>)",
        evidence: "<tool_use_error>Unknown skill: pony tail. Did you mean ponytail?</tool_use_error>"
      },
      {
        ruleId: "LPB001",
        plane: "thrash",
        severity: "CRITICAL",
        file: "rollout-2026-10-26T18-34-25-01a1784f.jsonl",
        detail: "fno.py mutated 6 times in rollout-2026-10-26T18-34-25-01a1784f.jsonl via apply_patch",
        evidence: "fno.py: 6 mutations"
      },
      {
        ruleId: "LPB001",
        plane: "thrash",
        severity: "CRITICAL",
        file: "rollout-2026-10-11T14-16-47-01a12a24.jsonl",
        detail: "brain.py mutated 4 times in rollout-2026-10-11T14-16-47-01a12a24.jsonl via codex:exec (shell-write bypass)",
        evidence: "brain.py: 4 mutations"
      },
      {
        ruleId: "LPB010",
        plane: "loop",
        severity: "CRITICAL",
        file: "5f37b3d3-3d5e-40bc-9890-dc7bb86b1a3b.jsonl",
        detail: "Deleted-sandbox CWD escape in 5f37b3d3-3d5e-40bc-9890-dc7bb86b1a3b.jsonl: shell recovered to ~ mid-session",
        evidence: "Working directory was deleted; shell cwd recovered to ~"
      },
      {
        ruleId: "LPB004",
        plane: "thrash",
        severity: "MEDIUM",
        file: "session-transcripts",
        detail: "78 source file mutation(s) (39.2% of all writes) executed via shell heredoc/sed/.write_text, bypassing structured Edit hooks",
        evidence: "78 shell writes vs 121 Edit/Write/apply_patch calls"
      }
    ]
  };
}