// i18n Provider for DispatchOS.
//
// Design goals (per user request, 2026-05-26):
//  - Switcher visible on the landing page (RU/EN).
//  - Selection persists for guests in localStorage (`dispatchos.lang`).
//  - After login, choice persists across sessions via the server-side
//    `users.preferred_lang` column.
//  - Hot-switching live without reload — components subscribe via `useT()`.
//
// On boot:
//  1. We read localStorage first (synchronous, works pre-auth).
//  2. After `useAuth()` resolves a logged-in user with `preferredLang`, we
//     reconcile: server choice WINS over local (the user could have set it
//     from another device), then we mirror back to localStorage.
//  3. Whenever the user picks a new language we (a) update Context, (b)
//     write localStorage, and (c) — if logged in — PATCH /api/me/preferences.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { translate, type Lang, LANGS } from "./translations";

const STORAGE_KEY = "dispatchos.lang";
const DEFAULT_LANG: Lang = "ru";

function isValidLang(v: unknown): v is Lang {
  return v === "ru" || v === "en";
}

function detectInitialLang(): Lang {
  if (typeof window === "undefined") return DEFAULT_LANG;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isValidLang(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  // Fall back to browser locale only if it's a language we actually ship.
  const browser = typeof navigator !== "undefined" ? navigator.language : "";
  if (browser?.toLowerCase().startsWith("ru")) return "ru";
  if (browser?.toLowerCase().startsWith("en")) return "en";
  return DEFAULT_LANG;
}

type I18nContextValue = {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  langs: typeof LANGS;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  // Keep <html lang="..."> in sync so screen readers + SEO crawlers pick
  // up the active language (Audit V2-26 partial fix).
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    if (!isValidLang(next)) return;
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable */
    }
    // Sync to server best-effort. We fire-and-forget — UI doesn't block on it.
    // The auth-aware sync component below also reconciles in the other
    // direction on login.
    void fetch("/api/me/preferences", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredLang: next }),
    }).catch(() => {
      /* not logged in — that's fine, guest just uses localStorage */
    });
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t, langs: LANGS }),
    [lang, setLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Subscribe to the active language + translator.
 * Throws (in dev) if used outside <I18nProvider>.
 */
export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useT() must be used inside <I18nProvider>");
  }
  return ctx;
}

/**
 * Once we have a logged-in user with a preferredLang on the server,
 * reconcile with the local value. Mount this once near the auth root.
 */
export function useSyncLangWithUser(serverLang: Lang | null | undefined) {
  const { lang, setLang } = useT();
  useEffect(() => {
    if (!serverLang) return;
    if (!isValidLang(serverLang)) return;
    if (serverLang !== lang) {
      // Server wins on initial reconciliation — user may have set it on
      // another device. We don't re-POST since the server already knows.
      try {
        window.localStorage.setItem(STORAGE_KEY, serverLang);
      } catch {
        /* ignore */
      }
      setLang(serverLang);
    }
  }, [serverLang, lang, setLang]);
}

export type { Lang };
export { LANGS };
