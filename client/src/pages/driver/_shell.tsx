import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Home, Package, FileText, User } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * DriverShell — общий layout для всех экранов /d/*.
 *
 * Mobile-first:
 *   - max-width 720px центрированный
 *   - top bar 56px высоты (logo + role hint)
 *   - bottom nav 64px высоты (4 таба, минимум 48px touch-target внутри)
 *   - main content scroll, padding-bottom для bottom nav
 *
 * Theme: оборачиваем в `dark theme-orange` чтобы получить tokens из Phase 4
 * палитры (orange accent + темнее фон, см. index.css :theme-orange). Админ
 * портал не задет — он рендерится без этого wrapper'а.
 *
 * Hash routing: useLocation возвращает path относительно `#/d`, потому что
 * мы внутри `<Route path="/d" nest>` (см. App.tsx).
 */
export function DriverShell({ children }: { children: ReactNode }) {
  return (
    <div className="dark theme-orange">
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <DriverTopBar />
        <main
          // pb-24 reserves room for the fixed bottom nav (64px + safe-area)
          className="mx-auto w-full max-w-[720px] flex-1 px-4 pb-24 pt-4"
        >
          {children}
        </main>
        <DriverBottomNav />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar — sticky, 56px. Logo + small "Driver" tag.
// ---------------------------------------------------------------------------

function DriverTopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 max-w-[720px] items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          {/* Simple inline logo mark. Brand swap will land alongside the admin
           *  recolor in a separate PR — for P0 we keep this minimal. */}
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
            D
          </span>
          <span className="text-base font-semibold tracking-tight">DispatchOS</span>
        </Link>
        <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
          Driver
        </span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Bottom nav — fixed, 4 tabs, touch targets ≥48px high (design-system §4.3).
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { href: "/", label: "Главная", icon: Home, match: (p: string) => p === "/" },
  { href: "/loads", label: "Рейсы", icon: Package, match: (p: string) => p.startsWith("/loads") },
  { href: "/documents", label: "Доки", icon: FileText, match: (p: string) => p.startsWith("/documents") },
  { href: "/profile", label: "Профиль", icon: User, match: (p: string) => p.startsWith("/profile") },
] as const;

function DriverBottomNav() {
  // useLocation here returns the path relative to the nested /d route. So `/`
  // is the dashboard, `/loads` is /d/loads, etc.
  const [location] = useLocation();

  return (
    <nav
      // Fixed at the bottom but constrained to the same max-width as main so
      // the visual rhythm stays consistent on tablet.
      className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80"
      aria-label="Навигация водителя"
    >
      <ul className="mx-auto flex h-16 max-w-[720px] items-stretch justify-around">
        {NAV_ITEMS.map((item) => {
          const isActive = item.match(location);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={cn(
                  "flex h-full min-h-[48px] flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon
                  className={cn("h-5 w-5", isActive && "stroke-[2.4]")}
                  aria-hidden="true"
                />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
