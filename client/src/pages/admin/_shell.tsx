import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Archive,
  Briefcase,
  CreditCard,
  Database,
  FileText,
  Headset,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Settings,
  Sparkles,
  Truck,
  Users,
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
import { ThemeToggle } from "@/components/dispatch/ThemeToggle";
import { RoleBadge } from "@/components/dispatch/RoleBadge";
import { cn } from "@/lib/utils";

/**
 * Admin shell — единый layout для всего /admin/*.
 *
 * Слева — sidebar с навигацией. Сверху — topbar с current user и theme toggle.
 * Контент рендерится через `children` (страница).
 *
 * Sidebar collapsible на мобильных через off-canvas.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Дашборд", icon: LayoutDashboard },
  { href: "/users", label: "Пользователи", icon: Users },
  { href: "/assignments", label: "Назначения", icon: Network },
  { href: "/clients", label: "Клиенты", icon: Briefcase },
  { href: "/loads", label: "Грузы", icon: Truck },
  { href: "/brokers", label: "Брокеры", icon: Headset },
  { href: "/documents", label: "Документы", icon: FileText },
  { href: "/audit", label: "Audit log", icon: History },
  { href: "/backup", label: "Backup", icon: Database },
  { href: "/billing", label: "Биллинг", icon: CreditCard },
  { href: "/settings", label: "Настройки", icon: Settings },
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
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === "/"
                ? currentPath === "/" || currentPath === ""
                : currentPath === item.href || currentPath.startsWith(item.href + "/");
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
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 px-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Legacy</p>
          <Link
            href="/legacy-dashboard"
            onClick={onNavigate}
            className="group mt-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent-soft hover:text-foreground"
          >
            <Archive className="h-3.5 w-3.5 transition-transform group-hover:scale-110" />
            Старый дашборд
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
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  async function handleLogout() {
    try {
      await apiJson("POST", "/api/auth/logout");
    } catch {
      // ignore — мы всё равно выкидываем юзера на /login
    }
    await refreshAuth();
    setLocation("~/login");
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md backdrop-saturate-150 md:px-6">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={onMobileMenu} aria-label="Меню">
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
            <Settings className="mr-2 h-4 w-4" /> Настройки
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
            <LogOut className="mr-2 h-4 w-4" /> Выйти
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

/** Skeleton-страница, временно для экранов которые я делаю в Ответе 2. */
export function AdminPlaceholderPage({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Admin / {title}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>

      {/* Mocked KPI strip (skeleton) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="card-hover rounded-lg border border-border bg-card p-5 shadow-card"
          >
            <div className="h-3 w-16 animate-skeleton" />
            <div className="mt-4 h-7 w-24 animate-skeleton" />
            <div className="mt-3 h-3 w-20 animate-skeleton" />
          </div>
        ))}
      </div>

      {/* "Coming in Part 2" hero */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-card">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 30% 50%, hsl(var(--primary) / 0.10), transparent 50%), radial-gradient(circle at 70% 50%, hsl(var(--chart-2) / 0.06), transparent 50%)",
          }}
        />
        <div className="relative flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <div className="relative">
            <div className="absolute inset-0 -m-4 rounded-full bg-primary/10 blur-xl" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
              <Sparkles className="h-6 w-6 text-primary" />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold">Экран в разработке</p>
            <p className="text-xs text-muted-foreground">
              Будет завершён в Ответе 2 второй части Phase 2.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
