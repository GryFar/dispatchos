import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * PageHeader — единый заголовок страницы для всех порталов.
 *
 *   <PageHeader
 *     title="Пользователи"
 *     subtitle="Все admin, диспетчеры и водители"
 *     actions={<Button>Создать invite</Button>}
 *   />
 */
export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
