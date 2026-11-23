import { useSyncExternalStore } from "react";
import { zh } from "./zh";
import { en } from "./en";

export type Language = "zh" | "en";
export type I18nKey = keyof typeof zh;

const STORAGE_KEY = "stemscribe_lang";

const dictionaries: Record<Language, Record<I18nKey, string>> = { zh, en };

let current: Language = loadInitial();
const listeners = new Set<(lang: Language) => void>();

function loadInitial(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
    if (
      saved === null &&
      typeof navigator !== "undefined" &&
      typeof navigator.language === "string" &&
      !navigator.language.toLowerCase().startsWith("zh")
    ) {
      return "en";
    }
  } catch {
    // localStorage unavailable (SSR / tests) — fall back to zh
  }
  return "zh";
}

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  listeners.forEach((fn) => fn(current));
}

export function onLanguageChange(fn: (lang: Language) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function t(key: I18nKey, params?: Record<string, string | number>): string {
  let s = dictionaries[current][key] ?? dictionaries.zh[key] ?? String(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

/** Re-render the calling component whenever the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(
    (cb) => onLanguageChange(cb),
    () => current,
    () => current
  );
}
