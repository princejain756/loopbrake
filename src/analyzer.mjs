import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
  }

  return { findings, structuredEditCalls, docManifestFilteredCount, thrashedFiles };
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
  const allThrashedFiles = [];

  for (const tf of transcriptFiles) {
    try {
      const res = analyzeSessionTranscript(tf);
      allFindings.push(...res.findings);
      structuredEditCalls += res.structuredEditCalls;
      docManifestFilteredCount += res.docManifestFilteredCount;
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

  return {
    sessionsScanned: transcriptFiles.length,
    severityCounts,
    ruleCounts,
    metrics: {
      structuredEditCalls,
      docManifestFilteredCount,
      thrashedFileCount: allThrashedFiles.length
    },
    thrashedFiles: allThrashedFiles.sort((a, b) => b.edits - a.edits),
    findings: allFindings
  };
}
