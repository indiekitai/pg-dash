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

const SNAPSHOT_FILE = "last-check.json";

export function saveSnapshot(dataDir: string, result: AdvisorResult): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const snapshot: Snapshot = { timestamp: new Date().toISOString(), result };
  fs.writeFileSync(path.join(dataDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
}

export function loadSnapshot(dataDir: string): Snapshot | null {
  const filePath = path.join(dataDir, SNAPSHOT_FILE);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function diffSnapshots(prev: AdvisorResult, current: AdvisorResult): SnapshotDiff {
  const prevIds = new Set(prev.issues.map((i) => i.id));
  const currIds = new Set(current.issues.map((i) => i.id));

  const newIssues = current.issues.filter((i) => !prevIds.has(i.id));
  const resolvedIssues = prev.issues.filter((i) => !currIds.has(i.id));
  const unchanged = current.issues.filter((i) => prevIds.has(i.id));

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
