import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * StatusBadge — единый бейдж для всех вердиктов и статусов в DispatchOS.
 *
 * Семантика цвета закреплена в design-system.md:
 *   emerald → success, book, clean, high
 *   amber   → warning, negotiate, verify, medium
 *   red     → danger, skip, stop, low, blocked
 *   slate   → neutral, info, default
 */

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        // Verdict (loads / brokers)
        book:      "bg-success/10 text-success border-success/25 dark:text-emerald-300",
        negotiate: "bg-warning/10 text-warning border-warning/25 dark:text-amber-300",
        skip:      "bg-destructive/10 text-destructive border-destructive/25 dark:text-red-300",

        // Broker verdict (synonyms of above)
        clean:  "bg-success/10 text-success border-success/25 dark:text-emerald-300",
        verify: "bg-warning/10 text-warning border-warning/25 dark:text-amber-300",
        stop:   "bg-destructive/10 text-destructive border-destructive/25 dark:text-red-300",

        // Confidence
        high:   "bg-success/10 text-success border-success/25 dark:text-emerald-300",
        medium: "bg-warning/10 text-warning border-warning/25 dark:text-amber-300",
        low:    "bg-destructive/10 text-destructive border-destructive/25 dark:text-red-300",

        // User / generic state
        active:  "bg-success/10 text-success border-success/25 dark:text-emerald-300",
        blocked: "bg-destructive/10 text-destructive border-destructive/25 dark:text-red-300",
        pending: "bg-warning/10 text-warning border-warning/25 dark:text-amber-300",

        // Neutral
        info:    "bg-muted text-foreground border-border",
        default: "bg-muted text-foreground border-border",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Show a small dot before the label */
  dot?: boolean;
}

export function StatusBadge({
  className,
  variant,
  dot,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            variant === "book" || variant === "clean" || variant === "high" || variant === "active" ? "bg-success" :
            variant === "negotiate" || variant === "verify" || variant === "medium" || variant === "pending" ? "bg-warning" :
            variant === "skip" || variant === "stop" || variant === "low" || variant === "blocked" ? "bg-destructive" :
            "bg-muted-foreground",
          )}
        />
      )}
      {children}
    </span>
  );
}
