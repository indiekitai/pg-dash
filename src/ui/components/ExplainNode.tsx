import React, { useState } from "react";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Startup Time"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Plan Rows"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Index Name"?: string;
  "Filter"?: string;
  "Index Cond"?: string;
  "Join Type"?: string;
  Plans?: PlanNode[];
  [key: string]: any;
}

function costColor(pct: number): string {
  if (pct < 20) return "text-green-400";
  if (pct < 50) return "text-yellow-400";
  if (pct < 80) return "text-orange-400";
  return "text-red-400";
}

function costBg(pct: number): string {
  if (pct < 20) return "bg-green-900/30 border-green-800";
  if (pct < 50) return "bg-yellow-900/30 border-yellow-800";
  if (pct < 80) return "bg-orange-900/30 border-orange-800";
  return "bg-red-900/30 border-red-800";
}

export function ExplainNode({ node, totalTime, isSlowest, depth = 0 }: {
  node: PlanNode; totalTime: number; isSlowest: boolean; depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const selfTime = (node["Actual Total Time"] || 0);
  const pct = totalTime > 0 ? (selfTime / totalTime) * 100 : 0;
  const hasChildren = node.Plans && node.Plans.length > 0;

  return (
    <div className={`${depth > 0 ? "ml-6 border-l border-gray-700 pl-3" : ""}`}>
      <div
        className={`rounded border p-2 mb-1 cursor-pointer ${isSlowest ? "ring-1 ring-red-500 " : ""}${costBg(pct)}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-wrap">
          {hasChildren && <span className="text-xs text-gray-500">{expanded ? "▼" : "▶"}</span>}
          <span className="font-semibold text-sm">{node["Node Type"]}</span>
          {node["Join Type"] && <span className="text-xs text-purple-400">({node["Join Type"]})</span>}
          {node["Relation Name"] && <span className="text-xs text-blue-400">on {node["Relation Name"]}</span>}
          {node["Index Name"] && <span className="text-xs text-cyan-400">using {node["Index Name"]}</span>}
          <span className={`text-xs font-mono ml-auto ${costColor(pct)}`}>{pct.toFixed(1)}%</span>
          {isSlowest && <span className="text-xs bg-red-800 text-red-200 px-1 rounded">slowest</span>}
        </div>
        <div className="flex gap-4 mt-1 text-xs text-gray-400 flex-wrap">
          <span>Time: <span className="text-gray-300">{node["Actual Startup Time"]?.toFixed(2)}..{selfTime.toFixed(2)}ms</span></span>
          <span>Rows: <span className="text-gray-300">{node["Actual Rows"]}</span> (est. {node["Plan Rows"]})</span>
          {(node["Rows Removed by Filter"] ?? 0) > 0 && (
            <span>Filtered: <span className="text-yellow-300">{node["Rows Removed by Filter"]}</span></span>
          )}
          {((node["Shared Hit Blocks"] ?? 0) > 0 || (node["Shared Read Blocks"] ?? 0) > 0) && (
            <span>Buffers: hit={node["Shared Hit Blocks"] || 0} read={node["Shared Read Blocks"] || 0}</span>
          )}
        </div>
        {node["Filter"] && <div className="text-xs text-gray-500 mt-1 font-mono">Filter: {node["Filter"]}</div>}
        {node["Index Cond"] && <div className="text-xs text-gray-500 mt-1 font-mono">Cond: {node["Index Cond"]}</div>}
      </div>
      {expanded && hasChildren && node.Plans!.map((child, i) => {
        const childSlowest = findSlowestTime(child) === findSlowestTime(node) && isSlowest;
        return <ExplainNode key={i} node={child} totalTime={totalTime} isSlowest={isNodeSlowest(child, totalTime)} depth={depth + 1} />;
      })}
    </div>
  );
}

function findSlowestTime(node: PlanNode): number {
  let max = node["Actual Total Time"] || 0;
  if (node.Plans) {
    for (const child of node.Plans) {
      max = Math.max(max, findSlowestTime(child));
    }
  }
  return max;
}

function isNodeSlowest(node: PlanNode, totalTime: number): boolean {
  // A node is "slowest" if it has the highest self-time contribution
  return false; // We mark slowest at the tree level
}

export function findSlowestNode(node: PlanNode): PlanNode {
  let slowest = node;
  let maxTime = node["Actual Total Time"] || 0;
  function walk(n: PlanNode) {
    const t = n["Actual Total Time"] || 0;
    // Leaf nodes or nodes with highest exclusive time
    if (!n.Plans || n.Plans.length === 0) {
      if (t > maxTime) { maxTime = t; slowest = n; }
    }
    if (n.Plans) n.Plans.forEach(walk);
  }
  walk(node);
  return slowest;
}
