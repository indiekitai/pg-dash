import React, { useState } from "react";
import { ExplainNode, findSlowestNode } from "./ExplainNode";
import { useTranslation } from "../i18n";

interface Props {
  plan: any[];
}

export function ExplainTree({ plan }: Props) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  if (!plan || plan.length === 0) return <p className="text-gray-500">{t("explain.noPlanData")}</p>;

  const root = plan[0]?.Plan;
  if (!root) return <p className="text-gray-500">{t("explain.invalidPlan")}</p>;

  const totalTime = root["Actual Total Time"] || 0;
  const slowest = findSlowestNode(root);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm text-gray-400">
        <span>{t("explain.totalTime")} <span className="text-white font-mono">{totalTime.toFixed(2)}ms</span></span>
        <span>{t("explain.planningTime")} <span className="text-white font-mono">{plan[0]?.["Planning Time"]?.toFixed(2) || "?"}ms</span></span>
        <span>{t("explain.executionTime")} <span className="text-white font-mono">{plan[0]?.["Execution Time"]?.toFixed(2) || "?"}ms</span></span>
      </div>
      <ExplainNode node={root} totalTime={totalTime} isSlowest={root === slowest} />
      <div>
        <button
          className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer"
          onClick={() => setShowRaw(!showRaw)}
        >
          {showRaw ? t("explain.hideRaw") : t("explain.showRaw")}
        </button>
        {showRaw && (
          <pre className="mt-2 bg-gray-950 rounded p-3 text-xs font-mono text-gray-400 overflow-auto max-h-96">
            {JSON.stringify(plan, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
