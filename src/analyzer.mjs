import fs from "node:fs";
import path from "node:path";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
const THRASH_THRESHOLD = 4;

// Walk a Claude Code transcript and record every source-file mutation together
// with the tool that made it. A transcript is JSONL: one event per line.
export function collectMutations(filePath) {
  const mutations = new Map();
  const content = fs.readFileSync(filePath, "utf8");

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== "assistant" || !Array.isArray(obj?.message?.content)) continue;

    for (const blk of obj.message.content) {
      if (blk?.type !== "tool_use") continue;
      const name = String(blk.name || "");
      if (!EDIT_TOOLS.has(name)) continue;

      const input = blk.input || {};
      const target = path.basename(String(input.file_path || input.path || ""));
      if (!target) continue;

      // A MultiEdit is one call but several hunks against the same file.
      const hunks = name === "MultiEdit" && Array.isArray(input.edits) ? input.edits.length : 1;
      for (let i = 0; i < hunks; i++) {
        if (!mutations.has(target)) mutations.set(target, []);
        mutations.get(target).push(name);
      }
    }
  }

  return mutations;
}

// Most-mutated files first, so the top of the list is where to start reading.
export function rankByMutations(mutations) {
  return [...mutations.entries()]
    .map(([file, methods]) => ({ file, edits: methods.length, methods: [...new Set(methods)] }))
    .sort((a, b) => b.edits - a.edits || a.file.localeCompare(b.file));
}

// Four mutations on one file means the agent kept guessing. Report each thrashing
// file once, with the tools it used, so the reason is legible without rerunning.
export function findThrashing(filePath) {
  const sessionLabel = path.basename(filePath);
  const ranked = rankByMutations(collectMutations(filePath));
  const findings = [];
  const thrashedFiles = [];

  for (const entry of ranked) {
    if (entry.edits < THRASH_THRESHOLD) continue;
    thrashedFiles.push(entry);
    findings.push({
      ruleId: "LPB001",
      plane: "thrash",
      severity: "CRITICAL",
      file: sessionLabel,
      detail: `${entry.file} mutated ${entry.edits} times in ${sessionLabel} via ${entry.methods.join(", ")}`,
      evidence: `${entry.file}: ${entry.edits} mutations`
    });
  }

  return { sessionLabel, findings, thrashedFiles, editCalls: totalEdits(ranked) };
}

function totalEdits(ranked) {
  return ranked.reduce((sum, entry) => sum + entry.edits, 0);
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

// Accept explicit paths, or fall back to the default Claude Code log directory.
export function resolveTranscriptFiles(targets) {
  const found = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    const st = fs.statSync(target);
    if (st.isDirectory()) collectJsonlFiles(target, found);
    else if (st.isFile() && target.endsWith(".jsonl")) found.push(target);
  }
  return found;
}

export function auditAgentLoops(paths = defaultPaths()) {
  const transcriptFiles = resolveTranscriptFiles(Array.isArray(paths) ? paths : defaultPaths());

  const findings = [];
  const thrashedFiles = [];
  let editCalls = 0;

  for (const tf of transcriptFiles) {
    try {
      const res = findThrashing(tf);
      findings.push(...res.findings);
      editCalls += res.editCalls;
      for (const item of res.thrashedFiles) {
        thrashedFiles.push({ session: res.sessionLabel, ...item });
      }
    } catch {
      // ignore unreadable transcript
    }
  }

  return {
    sessionsScanned: transcriptFiles.length,
    editCalls,
    thrashedFiles: thrashedFiles.sort((a, b) => b.edits - a.edits),
    findings
  };
}

function defaultPaths() {
  return [path.join(process.env.HOME || ".", ".claude", "projects")];
}
