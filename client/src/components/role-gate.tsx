import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import type { UserRole } from "@shared/schema";
import { useAuth } from "@/lib/use-auth";
import { useT } from "@/lib/i18n";

/**
 * RoleGate — оборачивает страницу/портал.
 *
 *   <RoleGate allow={["admin"]}>
 *     <AdminPortal />
 *   </RoleGate>
 *
 * Поведение:
 *   - isLoading → центрированный spinner (не "flicker" между login и portal)
 *   - !user → redirect на /login
 *   - user.role не в `allow` → redirect на дефолтный портал юзера
 *   - user.blocked → redirect на /login?reason=blocked
 *
 * Никаких 403-page'ей — просто незаметно отправляем туда, где user должен быть.
 */
export function RoleGate({ allow, children }: { allow: UserRole[]; children: ReactNode }) {
  const { t } = useT();
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      setLocation("~/login");
      return;
    }
    if (user.blocked) {
      setLocation("~/login?reason=blocked");
      return;
    }
    if (!allow.includes(user.role)) {
      setLocation("~" + defaultRouteForRole(user.role));
    }
  }, [user, isLoading, allow, setLocation]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="absolute inset-0 -m-2 animate-pulse rounded-full bg-primary/20 blur-md" />
            <Loader2 className="relative h-6 w-6 animate-spin text-primary" />
          </div>
          <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        </div>
      </div>
    );
  }
  if (!user || user.blocked || !allow.includes(user.role)) {
    return null;
  }
  return <>{children}</>;
}

/** Где пользователь данной роли должен находиться по умолчанию. */
export function defaultRouteForRole(role: UserRole): string {
  if (role === "admin") return "/admin";
  if (role === "dispatcher") return "/dispatch";
  // Phase 4 P0: driver portal lives at /d (was /me during the Phase 2 stub
  // era). The /api/me/* API namespace is unrelated and stays as-is.
  return "/d";
}
