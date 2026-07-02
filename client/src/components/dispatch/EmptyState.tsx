import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * EmptyState — стандартное пустое состояние.
 *
 *   <EmptyState
 *     icon={<Users />}
 *     title="Нет пользователей"
 *     description="Создайте первый invite для диспетчера или водителя."
 *     action={<Button>Создать invite</Button>}
 *   />
 *
 * Polish A: icon rendered in a ringed circle with a subtle glow.
 */
export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Visual tone for the icon ring — defaults to "primary". */
  tone?: "primary" | "muted";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  tone = "primary",
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div className="relative">
          <div
            className={cn(
              "absolute inset-0 -m-3 rounded-full blur-xl",
              tone === "primary" ? "bg-primary/15" : "bg-muted-foreground/10",
            )}
            aria-hidden
          />
          <div
            className={cn(
              "relative flex h-14 w-14 items-center justify-center rounded-full border",
              tone === "primary"
                ? "border-primary/20 bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground",
            )}
          >
            <span className="[&_svg]:h-6 [&_svg]:w-6">{icon}</span>
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
