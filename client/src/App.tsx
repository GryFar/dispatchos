import { lazy, Suspense, useEffect } from "react";
import { Route, Router, Switch, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { Loader2 } from "lucide-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/use-auth";
import { ThemeProvider } from "@/components/theme-provider";
import { RoleGate, defaultRouteForRole } from "@/components/role-gate";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider, useT, useSyncLangWithUser } from "@/lib/i18n";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import ForgotPasswordPage from "@/pages/forgot-password";
import OnboardingPage from "@/pages/onboarding";
import NotFound from "@/pages/not-found";

// Per-portal routers are code-split: each role's screens live in their own
// lazy-loaded chunk, so a driver on a phone never downloads the ~20-page admin
// portal or the dispatcher portal in the first paint. Vite emits one chunk per
// import() below; navigating into a portal fetches its chunk on demand
// (PortalLoading covers the brief fetch).
const AdminRouter = lazy(() => import("@/pages/admin/_router"));
const DispatchRouter = lazy(() => import("@/pages/dispatch/_router"));
const DriverRouter = lazy(() => import("@/pages/driver/_router"));

/**
 * Wrapped hash-location hook that strips any `?query` (and `#fragment`) from
 * the hash before passing the path to wouter's Switch / Route matcher.
 *
 * Why this exists:
 * - `signupUrl` returned by `/api/admin/invites` looks like
 *   `http://host/#/signup?code=DOS-XXXX-XXXX-XXXX`. With the stock
 *   `useHashLocation`, the matcher sees the path as `/signup?code=DOS-...`,
 *   so `<Route path="/signup">` doesn't match and the user lands on 404.
 * - The page itself (`signup.tsx`) reads the code via `window.location.hash`
 *   directly (parseHashSearch helper), so we only need to fix what the
 *   matcher sees — we don't need to expose the query to wouter at all.
 *
 * This is a 5-line wrapper and keeps wouter's navigate/SSR contract intact.
 */
function useStrippedHashLocation(): [string, (to: string, opts?: { replace?: boolean; state?: unknown }) => void] {
  const [raw, navigate] = useHashLocation();
  const stripped = raw.split(/[?#]/, 1)[0] || "/";
  return [stripped, navigate];
}
// Preserve the static `hrefs` helper wouter uses for `<Link href="...">`.
(useStrippedHashLocation as unknown as { hrefs: (href: string) => string }).hrefs =
  (useHashLocation as unknown as { hrefs: (href: string) => string }).hrefs;

/**
 * Full-screen spinner shown while a portal's lazy chunk is fetched. Mirrors the
 * RootRoute spinner so the transition reads as the same app, not a flash.
 */
function PortalLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Single entry-point for the whole web app.
 *
 * - Router uses hash-based location (main.tsx initialises window.location.hash
 *   to "#/"). This keeps the deployable static-host friendly.
 * - Three top-level role spaces: /admin/*, /dispatch/*, /d/*. Each is
 *   guarded by <RoleGate> and lazy-loaded (own chunk) behind <Suspense>.
 *   Unauthenticated users get bounced to /login; wrong-role users get bounced
 *   to their portal's home (silent).
 * - "/" is a smart root: anonymous visitors see the marketing landing;
 *   logged-in users are redirected to their portal home (defaultRouteForRole).
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AuthLangBridge />
      <ThemeProvider>
        <TooltipProvider delayDuration={150}>
          <Router hook={useStrippedHashLocation}>
            <Switch>
              {/* Public auth pages */}
              <Route path="/login" component={LoginPage} />
              <Route path="/signup" component={SignupPage} />
              <Route path="/forgot-password" component={ForgotPasswordPage} />
              <Route path="/onboarding" component={OnboardingPage} />

              {/* Admin space */}
              <Route path="/admin" nest>
                <RoleGate allow={["admin"]}>
                  <Suspense fallback={<PortalLoading />}>
                    <AdminRouter />
                  </Suspense>
                </RoleGate>
              </Route>

              {/* Dispatcher space (Phase 4 P0) */}
              <Route path="/dispatch" nest>
                <RoleGate allow={["dispatcher"]}>
                  <Suspense fallback={<PortalLoading />}>
                    <DispatchRouter />
                  </Suspense>
                </RoleGate>
              </Route>

              {/* Driver space (Phase 4 P0 — реализовано) */}
              <Route path="/d" nest>
                <RoleGate allow={["driver"]}>
                  <Suspense fallback={<PortalLoading />}>
                    <DriverRouter />
                  </Suspense>
                </RoleGate>
              </Route>

              {/* Smart root: landing for anonymous, portal redirect when logged in */}
              <Route path="/" component={RootRoute} />

              {/* 404 */}
              <Route component={NotFound} />
            </Switch>
          </Router>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

/**
 * Smart root route for "/".
 * - while auth is resolving: a spinner (avoids flashing the landing then yanking
 *   it away).
 * - logged-in: redirect to the role's portal home (replace, so Back doesn't trap
 *   the user on "/").
 * - anonymous: the public marketing landing.
 */
function RootRoute() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user) {
      setLocation(defaultRouteForRole(user.role), { replace: true });
    }
  }, [user, isLoading, setLocation]);

  if (isLoading || user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <LandingPage />;
}

/**
 * Bridges the i18n Context with the authenticated user — once `useAuth()`
 * has a server-side `preferredLang`, we adopt it so the choice persists
 * across devices and across logout/login on the same device.
 *
 * Rendered as a sibling to ThemeProvider inside <I18nProvider> so it has
 * access to both useAuth and useT.
 */
function AuthLangBridge() {
  const { user } = useAuth();
  // The User type may not yet have preferredLang in shared schema; cast
  // defensively. Server returns undefined for legacy users with no choice
  // recorded — we leave the local language untouched in that case.
  const serverLang = (user as unknown as { preferredLang?: "ru" | "en" } | null)
    ?.preferredLang;
  useSyncLangWithUser(serverLang ?? null);
  return null;
}
