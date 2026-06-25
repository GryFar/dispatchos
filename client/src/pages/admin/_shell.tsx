import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Briefcase,
  CreditCard,
  Database,
  FileText,
  Headset,
  History,
  Inbox,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Network,
  Plug,
  Radio,
  Settings,
  Truck,
  Users,
} from "lucide-react";
import { useAuth, clearAuthCache } from "@/lib/use-auth";
import { apiJson } from "@/lib/queryClient";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/dispatch/ThemeToggle";
import { RoleBadge } from "@/components/dispatch/RoleBadge";
import { BillingBanner } from "@/components/BillingBanner";
import { cn } from "@/lib/utils";

/**
 * Admin shell — единый layout для всего /admin/*.
 *
 * Слева — sidebar с навигацией. Сверху — topbar с current user и theme toggle.
 * Контент рендерится через `children` (страница).
 *
 * Sidebar collapsible на мобильных через off-canvas.
 *
 * Навигация теперь группирована (NavGroup[] вместо плоского массива).
 * Группа без `label` рендерится без заголовка (основная навигация),
 * группа с `label` — с разделителем и uppercase-заголовком (например,
 * "Платформа" — Интеграции, Входящая почта, Audit log, Backup).
 */

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  badgeKey?: "approvalQueueCount";
}

interface NavGroup {
  labelKey?: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    items: [
      { href: "/", labelKey: "admin.nav.dashboard", icon: LayoutDashboard },
      { href: "/users", labelKey: "admin.nav.users", icon: Users },
      { href: "/assignments", labelKey: "admin.nav.assignments", icon: Network },
      { href: "/clients", labelKey: "admin.nav.clients", icon: Briefcase },
      { href: "/loads", labelKey: "admin.nav.loads", icon: Truck },
      { href: "/brokers", labelKey: "admin.nav.brokers", icon: Headset },
      { href: "/documents", labelKey: "admin.nav.documents", icon: FileText },
      { href: "/queue", labelKey: "admin.nav.queue", icon: Inbox, badgeKey: "approvalQueueCount" },
      { href: "/billing", labelKey: "admin.nav.billing", icon: CreditCard },
      { href: "/settings", labelKey: "admin.nav.settings", icon: Settings },
    ],
  },
  {
    labelKey: "admin.nav.platform",
    items: [
      { href: "/integrations", labelKey: "admin.nav.integrations", icon: Plug },
      { href: "/load-sources", labelKey: "admin.nav.loadSources", icon: Radio },
      { href: "/email-inbox", labelKey: "admin.nav.emailInbox", icon: Mail },
      { href: "/audit", labelKey: "admin.nav.auditLog", icon: History },
      { href: "/backup", labelKey: "admin.nav.backup", icon: Database },
    ],
  },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar — desktop */}
      <aside className="sidebar-surface hidden w-60 shrink-0 border-r border-sidebar-border md:block">
        <SidebarContent currentPath={location} />
      </aside>

      {/* Sidebar — mobile off-canvas */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="sidebar-surface fixed inset-y-0 left-0 z-50 w-64 border-r border-sidebar-border shadow-pop md:hidden">
            <SidebarContent currentPath={location} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMobileMenu={() => setMobileOpen(true)} />
        <BillingBanner />
        <main className="flex-1 overflow-x-hidden">
          <div key={location} className="page-enter mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function SidebarContent({ currentPath, onNavigate }: { currentPath: string; onNavigate?: () => void }) {
  const { t } = useT();
  // Poll open approval-task count for the sidebar badge. 30 s is plenty —
  // drivers report issues at low volume and we don't need realtime here.
  const { data: queueData } = useQuery<{ total: number }>({
    queryKey: ["/api/admin/approval-tasks", "open-count"],
    queryFn: () => apiJson("GET", "/api/admin/approval-tasks?status=open&limit=1"),
    refetchInterval: 30_000,
  });
  const badges = {
    approvalQueueCount: queueData?.total ?? 0,
  };

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
          <Truck className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">DispatchOS</span>
        <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          Admin
        </span>
      </div>

      {/* Nav */}
      <nav className="sidebar-scroll flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((group, groupIdx) => (
          <div key={groupIdx} className={groupIdx > 0 ? "mt-5" : undefined}>
            {group.labelKey && (
              <p className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t(group.labelKey)}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active =
                  item.href === "/"
                    ? currentPath === "/" || currentPath === ""
                    : currentPath === item.href || currentPath.startsWith(item.href + "/");
                const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        "group relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-all duration-150",
                        active
                          ? "sidebar-item-active font-medium"
                          : "text-muted-foreground hover:bg-sidebar-accent-soft hover:text-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 transition-transform duration-150",
                          active ? "text-primary" : "group-hover:scale-110",
                        )}
                      />
                      <span className="flex-1">{t(item.labelKey)}</span>
                      {badgeCount > 0 && (
                        <span
                          className={cn(
                            "ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-primary/15 text-primary",
                          )}
                        >
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <div className="mt-6 px-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{t("admin.nav.legacy")}</p>
          <Link
            href="/legacy-dashboard"
            onClick={onNavigate}
            className="group mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent-soft hover:text-foreground"
          >
            <Archive className="h-3.5 w-3.5 transition-transform group-hover:scale-110" />
            {t("admin.nav.legacyDashboard")}
          </Link>
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border px-4 py-3 text-[10px] text-muted-foreground">
        v1.3.1-phase2
      </div>
    </div>
  );
}

function Topbar({ onMobileMenu }: { onMobileMenu: () => void }) {
  const { t } = useT();
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  async function handleLogout() {
    try {
      await apiJson("POST", "/api/auth/logout");
    } catch {
      // ignore — мы всё равно выкидываем юзера на /login
    }
    await clearAuthCache();
    setLocation("~/login");
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md backdrop-saturate-150 md:px-6">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={onMobileMenu} aria-label={t("admin.nav.menu")}>
        <Menu className="h-5 w-5" />
      </Button>

      <div className="flex-1" />

      <ThemeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="group h-9 gap-2 px-2 transition-all hover:bg-muted"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary ring-1 ring-primary/20 transition-all group-hover:ring-2 group-hover:ring-primary/40">
              {user?.fullName?.[0]?.toUpperCase() ?? "?"}
            </span>
            <span className="hidden text-sm font-medium sm:inline">{user?.fullName ?? "—"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 shadow-pop">
          <DropdownMenuLabel className="space-y-1.5 py-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/20">
                {user?.fullName?.[0]?.toUpperCase() ?? "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{user?.fullName}</div>
                <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
              </div>
            </div>
            {user?.role && (
              <div className="pt-1">
                <RoleBadge role={user.role} />
              </div>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setLocation("/settings")}>
            <Settings className="mr-2 h-4 w-4" /> {t("admin.nav.settings")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
            <LogOut className="mr-2 h-4 w-4" /> {t("common.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
