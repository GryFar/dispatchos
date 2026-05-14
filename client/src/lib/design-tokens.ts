/**
 * DispatchOS — design tokens in TypeScript form.
 *
 * Use ONLY where CSS classes don't cut it — e.g. passing colors to recharts,
 * computing variants at runtime, exporting palettes for docs. For most UI
 * code, use Tailwind classes that read from CSS vars instead.
 */

export const palette = {
  light: {
    background: "hsl(210 20% 98%)",
    foreground: "hsl(222 47% 11%)",
    card: "hsl(0 0% 100%)",
    border: "hsl(214 20% 91%)",
    primary: "hsl(158 64% 40%)",
    warning: "hsl(38 92% 50%)",
    destructive: "hsl(0 72% 51%)",
    mutedFg: "hsl(215 16% 47%)",
  },
  dark: {
    background: "hsl(222 47% 7%)",
    foreground: "hsl(210 20% 96%)",
    card: "hsl(222 47% 10%)",
    border: "hsl(215 28% 17%)",
    primary: "hsl(158 64% 45%)",
    warning: "hsl(38 92% 55%)",
    destructive: "hsl(0 72% 55%)",
    mutedFg: "hsl(217 11% 65%)",
  },
} as const;

/**
 * Chart colors keyed by series index (1..5). Same in light/dark — Tailwind
 * config remaps them via CSS vars, but for recharts you can pass hex.
 */
export const chartColors = ["#10b981", "#3b82f6", "#f59e0b", "#a855f7", "#dc2626"] as const;

/** Confidence dot colors */
export const confidenceColors = {
  high: "hsl(158 64% 40%)",
  medium: "hsl(38 92% 50%)",
  low: "hsl(0 72% 51%)",
} as const;

/** Role color hints — keep in sync with RoleBadge variants. */
export const roleColors = {
  admin: "hsl(158 64% 40%)",
  dispatcher: "hsl(217 91% 60%)",
  driver: "hsl(215 16% 47%)",
} as const;
