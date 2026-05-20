import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Truck,
} from "lucide-react";
import { useAuth, refreshAuth } from "@/lib/use-auth";
import { apiJson } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * DispatchShell — общий layout для всех экранов /dispatch/*.
 *
 * Desktop-first (как admin), с тем же sidebar+topbar паттерном — но
 * обёрнут в `theme-jade` для emerald-акцента.
 *
 * Sidebar collapsible на мобильных через off-canvas (та же логика что в
 * AdminShell). Hash routing: useLocation возвращает path относительно
 * `/dispatch` (мы внутри `<Route path="/dispatch" nest>` в App.tsx).
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badgeKey?: "queueCount";
}

const NAV: NavItem[] = [
  { href: "/", label: "Дашборд", icon: LayoutDashboard },
  { href: "/clients", label: "Клиенты", icon: Briefcase },
  { href: "/loads", label: "Грузы", icon: Truck },
  { href: "/queue", label: "Очередь", icon: Inbox, badgeKey: "queueCount" },
];

export function DispatchShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();

  return (
    <div className="dark theme-jade">
      <div className="flex min-h-screen bg-background text-foreground">
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
          <main className="flex-1 overflow-x-hidden">
            <div
              key={location}
              className="page-enter mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8"
            >
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function SidebarContent({
  currentPath,
  onNavigate,
}: {
  currentPath: string;
  onNavigate?: () => void;
}) {
  // Poll the dispatcher's open queue size for the sidebar badge. 30 s same
  // as admin queue — driver issues are low-volume.
  const { data: queueData } = useQuery<{ total: number }>({
    queryKey: ["/api/dispatch/approval-tasks", "open-count"],
    queryFn: () => apiJson("GET", "/api/dispatch/approval-tasks?status=open&limit=1"),
    refetchInterval: 30_000,
  });
  const badges = { queueCount: queueData?.total ?? 0 };

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
          <Truck className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">DispatchOS</span>
        <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
          Dispatch
        </span>
      </div>

      {/* Nav */}
      <nav className="sidebar-scroll flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {NAV.map((item) => {
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
                  <span className="flex-1">{item.label}</span>
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
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3 text-[10px] text-muted-foreground">
        Phase 4 P0 · dispatcher portal
      </div>
    </div>
  );
}

function Topbar({ onMobileMenu }: { onMobileMenu: () => void }) {
  const { user } = useAuth();
  const handleLogout = async () => {
    try {
      await apiJson("POST", "/api/auth/logout", {});
    } finally {
      await refreshAuth();
      window.location.hash = "#/login";
    }
  };
  return (
    <header className="flex h-14 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMobileMenu}
        aria-label="Меню"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <div className="ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <span className="text-xs">{user?.fullName || user?.email}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {user?.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className="text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              Выйти
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
