import { cn } from "@/lib/utils";
import { formatMoney, formatMoneyCents, formatPpm, formatMc } from "@/lib/format";

/** "$1,234" mono cell. Pass `cents` for $1,234.56 format. */
export function MoneyCell({
  value,
  cents = false,
  className,
}: {
  value: number | null | undefined;
  cents?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {cents ? formatMoneyCents(value) : formatMoney(value)}
    </span>
  );
}

/**
 * PpmCell — "$2.40/mi". If `target` provided, colors:
 *   value >= target          → success
 *   value >= target * 0.85   → warning
 *   below                    → destructive
 */
export function PpmCell({
  value,
  target,
  className,
}: {
  value: number | null | undefined;
  target?: number;
  className?: string;
}) {
  let tone: string | undefined;
  if (target != null && value != null && Number.isFinite(value)) {
    if (value >= target) tone = "text-success";
    else if (value >= target * 0.85) tone = "text-warning";
    else tone = "text-destructive";
  }
  return (
    <span className={cn("font-mono tabular-nums", tone, className)}>{formatPpm(value)}</span>
  );
}

/** "MC-123456" mono cell. */
export function McCell({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return <span className={cn("font-mono tabular-nums", className)}>{formatMc(value)}</span>;
}
