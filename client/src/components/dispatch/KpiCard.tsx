import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * KpiCard — единая карточка показателя для Dashboard и summary-блоков.
 *
 *   <KpiCard label="MRR" value={formatMoney(12400)} helper="6 active clients"
 *            icon={<DollarSign />} trend={{ direction: "up", value: "+8.2%" }} />
 *
 * Polish A: card-hover lift, accent-tinted icon container, optional count-up
 * animation for numeric values.
 */
export interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** If provided, animates from 0 to this number over ~600ms on mount. value prop is overridden. */
  numericValue?: number;
  /** How to format the count-up value into a string (e.g. formatMoney). */
  formatNumeric?: (n: number) => string;
  helper?: ReactNode;
  icon?: ReactNode;
  /** Icon container accent — defaults to "muted". */
  accent?: "muted" | "primary" | "warning" | "destructive" | "chart-2";
  trend?: { direction: "up" | "down" | "flat"; value: string; positive?: boolean };
  className?: string;
}

const accentClasses = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary ring-1 ring-primary/15",
  warning: "bg-warning/10 text-warning ring-1 ring-warning/15",
  destructive: "bg-destructive/10 text-destructive ring-1 ring-destructive/15",
  "chart-2": "bg-[hsl(var(--chart-2)/0.10)] text-[hsl(var(--chart-2))] ring-1 ring-[hsl(var(--chart-2)/0.15)]",
} as const;

export function KpiCard({
  label,
  value,
  numericValue,
  formatNumeric,
  helper,
  icon,
  accent = "muted",
  trend,
  className,
}: KpiCardProps) {
  const displayValue = useCountUp(numericValue, formatNumeric) ?? value;

  return (
    <Card className={cn("card-hover shadow-card", className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="kpi-label">{label}</p>
            <p className="kpi-value mt-2">{displayValue}</p>
            {helper && <p className="mt-2 truncate text-xs text-muted-foreground">{helper}</p>}
          </div>
          {icon && (
            <div
              className={cn(
                "shrink-0 rounded-md p-2 transition-transform duration-150 group-hover:scale-110",
                accentClasses[accent],
              )}
            >
              {icon}
            </div>
          )}
        </div>
        {trend && (
          <div
            className={cn(
              "mt-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              trend.direction === "up" && (trend.positive !== false
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive"),
              trend.direction === "down" && (trend.positive !== false
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success"),
              trend.direction === "flat" && "bg-muted text-muted-foreground",
            )}
          >
            {trend.direction === "up" && <ArrowUp className="h-3 w-3" />}
            {trend.direction === "down" && <ArrowDown className="h-3 w-3" />}
            {trend.direction === "flat" && <Minus className="h-3 w-3" />}
            {trend.value}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * useCountUp — ease-out animation from 0 to target over ~600ms on mount.
 * Returns null if no numeric value provided (so KpiCard falls back to `value`).
 */
function useCountUp(target?: number, format?: (n: number) => string): string | null {
  const [display, setDisplay] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) {
      setDisplay(null);
      return;
    }
    // Respect reduced motion — show final value immediately.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(format ? format(target) : String(target));
      return;
    }
    const duration = 600;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const current = target * eased;
      setDisplay(format ? format(current) : String(Math.round(current)));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, format]);

  return display;
}
