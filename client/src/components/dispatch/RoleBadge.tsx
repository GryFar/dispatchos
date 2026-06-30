import { Shield, Headset, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * RoleBadge — стабильный визуал роли. Используется в Users table,
 * в topbar (current user), в audit log.
 */
export function RoleBadge({
  role,
  className,
  size = "sm",
}: {
  role: "admin" | "dispatcher" | "driver";
  className?: string;
  size?: "sm" | "md";
}) {
  const { t } = useT();
  const labels = {
    admin: t("dispatch.RoleBadge.admin"),
    dispatcher: t("dispatch.RoleBadge.dispatcher"),
    driver: t("dispatch.RoleBadge.driver"),
  };
  const Icon = role === "admin" ? Shield : role === "dispatcher" ? Headset : Truck;
  const tone =
    role === "admin"
      ? "bg-primary/10 text-primary border-primary/25"
      : role === "dispatcher"
      ? "bg-[hsl(217_91%_60%/0.10)] text-[hsl(217_91%_50%)] border-[hsl(217_91%_60%/0.25)] dark:text-[hsl(217_91%_70%)]"
      : "bg-muted text-muted-foreground border-border";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap",
        size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm",
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} />
      {labels[role] ?? role}
    </span>
  );
}
