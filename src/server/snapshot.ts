import fs from "node:fs";
import path from "node:path";
import type { AdvisorResult, AdvisorIssue } from "./advisor.js";

export interface Snapshot {
  timestamp: string;
  result: AdvisorResult;
}

export interface SnapshotDiff {
  scoreDelta: number;
  previousScore: number;
  currentScore: number;
  previousGrade: string;
  currentGrade: string;
  newIssues: AdvisorIssue[];
  resolvedIssues: AdvisorIssue[];
  unchanged: AdvisorIssue[];
}

/**
 * Normalize a dynamic issue ID for stable comparison.
 * Strips trailing -<number> suffixes so IDs like `maint-idle-12345`
 * (where 12345 is a PID that changes every run) don't produce false noise.
 */
function normalizeIssueId(id: string): string {
  return id.replace(/-\d+$/, "");
}

/**
 * Save a health-check snapshot to a specific file path.
 * The parent directory is created automatically.
 *
 * @param snapshotPath  Full path to the JSON file (e.g. ~/.pg-dash/last-check.json)
 */
export function saveSnapshot(snapshotPath: string, result: AdvisorResult): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const snapshot: Snapshot = { timestamp: new Date().toISOString(), result };
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
}

/**
 * Load a previously saved snapshot from a specific file path.
 * Returns null if the file doesn't exist or cannot be parsed.
 *
 * @param snapshotPath  Full path to the JSON file
 */
export function loadSnapshot(snapshotPath: string): Snapshot | null {
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
  } catch {
    return null;
  }
}

export function diffSnapshots(prev: AdvisorResult, current: AdvisorResult): SnapshotDiff {
  // Use normalized IDs for comparison to avoid noise from dynamic suffixes
  // (e.g. maint-idle-12345 where 12345 is a PID that changes every run).
  const prevNormIds = new Set(prev.issues.map((i) => normalizeIssueId(i.id)));
  const currNormIds = new Set(current.issues.map((i) => normalizeIssueId(i.id)));

  const newIssues = current.issues.filter((i) => !prevNormIds.has(normalizeIssueId(i.id)));
  const resolvedIssues = prev.issues.filter((i) => !currNormIds.has(normalizeIssueId(i.id)));
  const unchanged = current.issues.filter((i) => prevNormIds.has(normalizeIssueId(i.id)));

  return {
    scoreDelta: current.score - prev.score,
    previousScore: prev.score,
    currentScore: current.score,
    previousGrade: prev.grade,
    currentGrade: current.grade,
    newIssues,
    resolvedIssues,
    unchanged,
  };
}
