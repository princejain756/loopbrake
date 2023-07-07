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

export function analyzeSessionTranscript(filePath) {
  const findings = [];
  const sessionLabel = path.basename(filePath);

  let structuredEditCalls = 0;
  let docManifestFilteredCount = 0;
  let sameTargetOverlapCount = 0;
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
        if (!["Edit", "MultiEdit", "Write"].includes(name)) continue;

        const input = blk.input || {};
        const fp = path.basename(String(input.file_path || input.path || "unknown"));
        // End-of-task README/package.json churn is expected, not thrashing.
        if (DOC_OR_MANIFEST_RE.test(fp)) {
          docManifestFilteredCount++;
          continue;
        }
        structuredEditCalls++;

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
  let docManifestFilteredCount = 0;
  let sameTargetOverlapCount = 0;
  const allThrashedFiles = [];

  for (const tf of transcriptFiles) {
    try {
      const res = analyzeSessionTranscript(tf);
      allFindings.push(...res.findings);
      structuredEditCalls += res.structuredEditCalls;
      docManifestFilteredCount += res.docManifestFilteredCount;
      sameTargetOverlapCount += res.sameTargetOverlapCount;
      for (const item of res.thrashedFiles) {
        allThrashedFiles.push({ session: path.basename(tf), ...item });
      }
    } catch {
      // ignore unreadable transcript
    }
  }

  if (docManifestFilteredCount > 0) {
    allFindings.push({
      ruleId: "LPB007",
      plane: "thrash",
      severity: "INFO",
      file: "session-transcripts",
      detail: `${docManifestFilteredCount} doc/manifest edit(s) excluded from source thrash counts`,
      evidence: `${docManifestFilteredCount} doc/manifest updates`
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

  return {
    sessionsScanned: transcriptFiles.length,
    score,
    grade,
    severityCounts,
    ruleCounts,
    metrics: {
      structuredEditCalls,
      docManifestFilteredCount,
      sameTargetOverlapCount,
      thrashedFileCount: allThrashedFiles.length
    },
    thrashedFiles: allThrashedFiles.sort((a, b) => b.edits - a.edits),
    findings: allFindings
  };
}