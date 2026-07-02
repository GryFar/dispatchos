import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Home, Package, FileText, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/dispatch/ThemeToggle";
import { SubscriptionBadge } from "@/components/SubscriptionBadge";
import { AiQuotaBadge } from "@/components/AiQuotaBadge";
import { BillingLink, TrialBanner } from "@/components/TrialBanner";

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
    <div>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <DriverTopBar />
        <main
          // pb-24 reserves room for the fixed bottom nav (64px + safe-area)
          className="mx-auto w-full max-w-[720px] flex-1 px-4 pb-24 pt-4"
        >
          {/* Carrier owners only (non-owners render nothing, see TrialBanner) */}
          <TrialBanner />
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
  const { t } = useT();
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
        <div className="flex items-center gap-1">
          <BillingLink />
          <SubscriptionBadge />
          <AiQuotaBadge />
          <LanguageSwitcher variant="inline" />
          <ThemeToggle />
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
            {t("driver._shell.roleTag")}
          </span>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Bottom nav — fixed, 4 tabs, touch targets ≥48px high (design-system §4.3).
// ---------------------------------------------------------------------------

function DriverBottomNav() {
  const { t } = useT();
  // useLocation here returns the path relative to the nested /d route. So `/`
  // is the dashboard, `/loads` is /d/loads, etc.
  const [location] = useLocation();

  const NAV_ITEMS = [
    { href: "/", label: t("driver._shell.nav.home"), icon: Home, match: (p: string) => p === "/" },
    { href: "/loads", label: t("driver._shell.nav.loads"), icon: Package, match: (p: string) => p.startsWith("/loads") },
    { href: "/documents", label: t("driver._shell.nav.docs"), icon: FileText, match: (p: string) => p.startsWith("/documents") },
    { href: "/profile", label: t("driver._shell.nav.profile"), icon: User, match: (p: string) => p.startsWith("/profile") },
  ] as const;

  return (
    <nav
      // Fixed at the bottom but constrained to the same max-width as main so
      // the visual rhythm stays consistent on tablet.
      className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80"
      aria-label={t("driver._shell.nav.aria_label")}
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
