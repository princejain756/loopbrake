import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const RULE_META = {
  // Plane 1: file edit thrashing and patch overlap
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
  LPB006: {
    id: "LPB006",
    plane: "thrash",
    severity: "INFO",
    title: "Read-Only python3 -c / sed -n Inspections Separated (False-Positive Guard)",
    points: 0
  },
  LPB007: {
    id: "LPB007",
    plane: "thrash",
    severity: "INFO",
    title: "Doc/Manifest Updates Filtered from Source Thrash Counts (False-Positive Guard)",
    points: 0
  }
};

const SOURCE_FILE_RE = /\b([a-zA-Z0-9_.-]+\.(?:py|mjs|cjs|js|ts|tsx|jsx|rs|go|java|c|cpp|h|rb|php|swift|kt|sql|sh|css|html|vue|svelte))\b/g;
const DOC_OR_MANIFEST_RE = /^(?:README\.md|CHANGELOG\.md|LICENSE|package\.json|package-lock\.json|pnpm-lock\.yaml|Cargo\.toml|Cargo\.lock|pyproject\.toml)$/i;

export function extractTargetSourceFiles(cmd) {
  const s = String(cmd || "");
  const matches = [...s.matchAll(SOURCE_FILE_RE)].map((m) => path.basename(m[1]));
  return [...new Set(matches)].filter((f) => !DOC_OR_MANIFEST_RE.test(f));
}

// Shell idioms that actually rewrite a file. A bare `cat file.py` is not a write,
// but a heredoc, an in-place sed/perl edit or a Python write call is.
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

export function analyzeSessionTranscript(filePath) {
  const findings = [];
  const sessionLabel = path.basename(filePath);

  let structuredEditCalls = 0;
  let shellMutationCalls = 0;
  let readOnlyPythonOrSedCount = 0;
  let jsonlPrefixCollisionCount = 0;
  let docManifestFilteredCount = 0;
  let sameTargetOverlapCount = 0;
  const readFiles = new Set();
  const fileMutations = new Map();

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

    if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
      for (const blk of obj.message.content) {
        if (blk?.type !== "tool_use") continue;
        const name = String(blk.name || "");
        const input = blk.input || {};

        if (name === "Read") {
          const fp = path.basename(String(input.file_path || input.path || ""));
          if (fp) readFiles.add(fp);
          continue;
        }

        if (name === "Bash") {
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
          continue;
        }

        if (!["Edit", "MultiEdit", "Write"].includes(name)) continue;

        const fp = path.basename(String(input.file_path || input.path || "unknown"));
        // End-of-task README/package.json churn is expected, not thrashing.
        if (DOC_OR_MANIFEST_RE.test(fp)) {
          docManifestFilteredCount++;
          continue;
        }
        structuredEditCalls++;
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
      }
    }
  }

  // Same-file edit thrashing. Four mutations is a redesign; three is already a band-aid.
  const thrashedFiles = [];
  for (const [fp, list] of fileMutations.entries()) {
    if (list.length < 3) continue;
    const methods = [...new Set(list.map((x) => x.method))];
    thrashedFiles.push({ file: fp, edits: list.length, methods });
    if (list.length >= 4) {
      findings.push({
        ruleId: "LPB001",
        plane: "thrash",
        severity: "CRITICAL",
        file: sessionLabel,
        detail: `${fp} mutated ${list.length} times in ${sessionLabel} via ${methods.join(", ")}`,
        evidence: `${fp}: ${list.length} mutations`
      });
    } else {
      findings.push({
        ruleId: "LPB002",
        plane: "thrash",
        severity: "HIGH",
        file: sessionLabel,
        detail: `${fp} patched 3 times in ${sessionLabel} via ${methods.join(", ")} (band-aid threshold)`,
        evidence: `${fp}: 3 mutations`
      });
    }

    // Overlapping hunks: a later old_string carries text the previous new_string
    // introduced, which means the earlier patch is being partially reverted.
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.newStr || a.newStr.length < 15) continue;
      const prefixA = a.newStr.slice(0, Math.min(50, a.newStr.length));
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.oldStr || b.oldStr.length < 15) continue;
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

  return {
    findings,
    structuredEditCalls,
    shellMutationCalls,
    readOnlyPythonOrSedCount,
    jsonlPrefixCollisionCount,
    docManifestFilteredCount,
    sameTargetOverlapCount,
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
    // unreadable directory: keep whatever was collected so far
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
      options.transcriptFiles || collectJsonlFiles(path.join(home, ".claude", "projects"));
  }

  const allFindings = [];
  let structuredEditCalls = 0;
  let shellMutationCalls = 0;
  let readOnlyPythonOrSedCount = 0;
  let jsonlPrefixCollisionCount = 0;
  let docManifestFilteredCount = 0;
  let sameTargetOverlapCount = 0;
  const allThrashedFiles = [];

  for (const tf of transcriptFiles) {
    try {
      const res = analyzeSessionTranscript(tf);
      allFindings.push(...res.findings);
      structuredEditCalls += res.structuredEditCalls;
      shellMutationCalls += res.shellMutationCalls;
      readOnlyPythonOrSedCount += res.readOnlyPythonOrSedCount;
      jsonlPrefixCollisionCount += res.jsonlPrefixCollisionCount;
      docManifestFilteredCount += res.docManifestFilteredCount;
      sameTargetOverlapCount += res.sameTargetOverlapCount;
      for (const item of res.thrashedFiles) {
        allThrashedFiles.push({ session: path.basename(tf), ...item });
      }
    } catch {
      // ignore unreadable transcript
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

  const ruleCounts = {};
  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of allFindings) {
    ruleCounts[f.ruleId] = (ruleCounts[f.ruleId] || 0) + 1;
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  // Each rule carries a fixed penalty that saturates so one very noisy rule
  // cannot drag a whole repo to zero on its own.
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
      sameTargetOverlapCount,
      thrashedFileCount: allThrashedFiles.length
    },
    thrashedFiles: allThrashedFiles.sort((a, b) => b.edits - a.edits),
    findings: allFindings
  };
}