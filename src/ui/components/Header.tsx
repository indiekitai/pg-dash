import { useState } from "react";
import type { Overview, AdvisorResult } from "../types";
import { gradeColors } from "../types";
import { Skeleton } from "./Skeleton";
import { useTranslation } from "../i18n";

function ExportDropdown() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const download = (format: string) => {
    window.open(`/api/export?format=${format}`, "_blank");
    setOpen(false);
  };
  return (
    <div className="relative">
      <button className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded cursor-pointer" onClick={() => setOpen(!open)}>📥 {t("header.export")}</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg z-50 min-w-[120px]">
            <button className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-700 cursor-pointer" onClick={() => download("json")}>{t("header.exportJson")}</button>
            <button className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-700 cursor-pointer" onClick={() => download("md")}>{t("header.exportMarkdown")}</button>
          </div>
        </>
      )}
    </div>
  );
}

function LanguageSwitcher() {
  const { lang, setLang, t } = useTranslation();
  const base = "px-2 py-1 text-sm rounded cursor-pointer transition-colors";
  const active = "bg-indigo-600 text-white";
  const inactive = "bg-gray-700 hover:bg-gray-600 text-gray-200";
  return (
    <div className="inline-flex items-center gap-0.5 bg-gray-800 rounded p-0.5" role="group" aria-label={t("header.language")}>
      <button
        className={`${base} ${lang === "en" ? active : inactive}`}
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
      >EN</button>
      <button
        className={`${base} ${lang === "zh" ? active : inactive}`}
        onClick={() => setLang("zh")}
        aria-pressed={lang === "zh"}
      >中</button>
    </div>
  );
}

export function Header({ overview, health, connected }: { overview: Overview | null; health: AdvisorResult | null; connected: boolean }) {
  const { t } = useTranslation();
  return (
    <header className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">🐘 {t("header.title")}</h1>
        {health && (
          <span className={`text-xl font-black border-2 rounded-lg px-2 py-0.5 ${gradeColors[health.grade] || "border-gray-600"}`}>
            {health.grade}
          </span>
        )}
        <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} title={connected ? t("common.live") : t("common.disconnected")} />
        <ExportDropdown />
        <LanguageSwitcher />
      </div>
      {overview ? (
        <div className="text-sm text-gray-400 flex flex-wrap gap-x-4">
          <span>{t("header.postgresVersion")} {overview.version}</span>
          <span>{t("header.uptime")}: {typeof overview.uptime === 'object' && overview.uptime !== null
            ? `${(overview.uptime as any).days ?? 0}${t("time.day")} ${(overview.uptime as any).hours ?? 0}${t("time.hour")} ${(overview.uptime as any).minutes ?? 0}${t("time.minute")}`
            : overview.uptime}</span>
          <span>{t("header.size")}: {overview.dbSize}</span>
        </div>
      ) : (
        <div className="flex gap-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-16" /></div>
      )}
    </header>
  );
}
