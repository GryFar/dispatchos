// Compact RU/EN toggle.
//
// Two visual variants:
//   - `variant="ghost"`  — for the landing page (dark hero, transparent bg).
//   - `variant="inline"` — for in-app shells (already on a dark surface).
//
// Behaviour identical: clicking a code calls `setLang`, the global i18n
// Context updates, localStorage is written, and (if logged in) the server
// preference is PATCHed.

import { useT } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";

type Props = {
  variant?: "ghost" | "inline";
  className?: string;
};

export function LanguageSwitcher({ variant = "ghost", className = "" }: Props) {
  const { lang, setLang, langs, t } = useT();

  const isGhost = variant === "ghost";
  const wrap = isGhost
    ? "inline-flex items-center gap-0.5 rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.04)] p-0.5 text-xs"
    : "inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 text-xs";

  const btn = (active: boolean) =>
    isGhost
      ? `rounded-full px-2.5 py-1 font-semibold transition-colors ${
          active
            ? "bg-[#f59e0b] text-[#0a0e1a]"
            : "text-[#9aa3ba] hover:text-white"
        }`
      : `rounded px-2 py-0.5 font-semibold transition-colors ${
          active
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`;

  return (
    <div className={`${wrap} ${className}`} role="group" aria-label={t("lang.switch")}>
      {langs.map((l) => {
        const active = l.code === lang;
        return (
          <button
            key={l.code}
            type="button"
            onClick={() => setLang(l.code as Lang)}
            className={btn(active)}
            aria-pressed={active}
            aria-label={t(`lang.${l.code}`)}
            data-testid={`lang-switch-${l.code}`}
          >
            {l.short}
          </button>
        );
      })}
    </div>
  );
}
