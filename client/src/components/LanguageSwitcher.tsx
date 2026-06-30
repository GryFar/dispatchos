// Language selector — 4-option dropdown (EN / RU / ES / FR).
//
// Two visual variants:
//   - `variant="ghost"`  — for the landing page (dark hero, transparent bg).
//   - `variant="inline"` — for in-app shells (already on a dark surface).
//
// Behaviour: selecting a language calls `setLang`, the global i18n Context
// updates, localStorage is written, and (if logged in) the server preference
// is PATCHed via /api/me/preferences.

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";

type Props = {
  variant?: "ghost" | "inline";
  className?: string;
};

export function LanguageSwitcher({ variant = "ghost", className = "" }: Props) {
  const { lang, setLang, langs, t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isGhost = variant === "ghost";

  const triggerClass = isGhost
    ? "inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.04)] px-3 py-1 text-xs font-semibold text-[#9aa3ba] hover:text-white transition-colors cursor-pointer select-none"
    : "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none";

  const menuClass = isGhost
    ? "absolute right-0 mt-1 min-w-[140px] rounded-xl border border-[rgba(255,255,255,0.10)] bg-[#0e1223] shadow-lg py-1 z-50"
    : "absolute right-0 mt-1 min-w-[140px] rounded-lg border border-border bg-popover shadow-md py-1 z-50";

  const itemClass = (active: boolean) =>
    isGhost
      ? `flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
          active ? "text-[#f59e0b]" : "text-[#9aa3ba] hover:text-white"
        }`
      : `flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
          active ? "text-primary" : "text-muted-foreground hover:text-foreground"
        }`;

  const current = langs.find((l) => l.code === lang);

  // Close dropdown when clicking outside
  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!ref.current?.contains(e.relatedTarget as Node)) {
      setOpen(false);
    }
  }

  return (
    <div
      ref={ref}
      className={`relative ${className}`}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className={triggerClass}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("lang.switch")}
        data-testid="lang-switcher-trigger"
      >
        <span>{current?.flag}</span>
        <span>{current?.short ?? lang.toUpperCase()}</span>
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className={menuClass} role="listbox" aria-label={t("lang.switch")}>
          {langs.map((l) => {
            const active = l.code === lang;
            return (
              <button
                key={l.code}
                type="button"
                role="option"
                aria-selected={active}
                className={itemClass(active)}
                data-testid={`lang-switch-${l.code}`}
                onClick={() => {
                  setLang(l.code as Lang);
                  setOpen(false);
                }}
              >
                <span className="text-base leading-none">{l.flag}</span>
                <span>{l.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
