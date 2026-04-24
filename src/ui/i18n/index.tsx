import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { en, type Dict } from "./en";
import { zh } from "./zh";

export type Lang = "en" | "zh";

const DICTS: Record<Lang, Dict> = { en, zh };
const STORAGE_KEY = "pgdash.lang";

function resolve(dict: any, path: string): string | undefined {
  const parts = path.split(".");
  let cur: any = dict;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

function readInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {}
  return "en";
}

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (path: string, vars?: Record<string, string | number>) => string;
  tn: (path: string, count: number, vars?: Record<string, string | number>) => string;
}

const LangContext = createContext<Ctx | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);

  useEffect(() => {
    try {
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    } catch {}
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch {}
  }, []);

  const t = useCallback((path: string, vars?: Record<string, string | number>) => {
    const dict = DICTS[lang];
    const raw = resolve(dict, path) ?? resolve(en, path) ?? path;
    return interpolate(raw, vars);
  }, [lang]);

  const tn = useCallback((basePath: string, count: number, vars?: Record<string, string | number>) => {
    const suffix = count === 1 ? "_one" : "_other";
    const dict = DICTS[lang];
    const raw =
      resolve(dict, basePath + suffix) ??
      resolve(en, basePath + suffix) ??
      resolve(dict, basePath) ??
      resolve(en, basePath) ??
      basePath;
    return interpolate(raw, { count, ...(vars ?? {}) });
  }, [lang]);

  const value = useMemo<Ctx>(() => ({ lang, setLang, t, tn }), [lang, setLang, t, tn]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useTranslation(): Ctx {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useTranslation must be used within LanguageProvider");
  return ctx;
}

export function formatRelative(ts: number, lang: Lang, now = Date.now()): string {
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 5) return lang === "zh" ? "刚刚" : "just now";
  if (lang === "zh") {
    if (diffSec < 60) return `${diffSec} 秒前`;
    const m = Math.floor(diffSec / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return `${d} 天前`;
  }
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function localeCode(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-US";
}
