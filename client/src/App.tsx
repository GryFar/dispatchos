import { Component, lazy, Suspense, useEffect } from "react";
import type { ErrorInfo, ReactNode } from "react";
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
import ResetPasswordPage from "@/pages/reset-password";
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
// Customer billing (carrier owners are role 'driver'; the page itself shows an
// owner-only notice for hired drivers — the server 403s them).
const CustomerBillingPage = lazy(() => import("@/pages/billing"));

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
 * Detects the "stale chunk" failure: after a new deploy, the old index chunk a
 * still-open tab is running references portal chunk hashes that 404 on the CDN,
 * so the dynamic import() REJECTS. Browsers surface this with varied messages
 * ("Failed to fetch dynamically imported module", "error loading dynamically
 * imported module", "Importing a module script failed"), so we match loosely.
 */
function isChunkLoadError(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    /dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /loading chunk/i.test(msg) ||
    /ChunkLoadError/i.test((error as { name?: string })?.name ?? "")
  );
}

// Guards the one-shot auto-reload below so a genuinely broken deploy can't spin
// the tab in an infinite reload loop.
const CHUNK_RELOAD_FLAG = "dos:chunkReloaded";

interface PortalBoundaryState {
  error: Error | null;
}

/**
 * Error boundary wrapping the lazy-loaded portal routers.
 *
 * Without this, a rejected dynamic import() (e.g. a stale chunk 404 after a new
 * deploy) propagates past <Suspense> — which only catches the *pending* promise,
 * not a *rejected* one — and white-screens the whole SPA with no recovery. Here
 * we catch it and offer a reload, which re-fetches the fresh index + chunk
 * manifest. For the common stale-chunk case we auto-reload once (guarded by a
 * sessionStorage flag so we never loop); for anything else we show a manual
 * reload button.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, PortalBoundaryState> {
  state: PortalBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PortalBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // Stale-chunk after deploy → reload once to pull the fresh chunk manifest.
    // The sessionStorage flag ensures we attempt this at most once per tab so a
    // truly broken build degrades to the manual button instead of looping.
    if (isChunkLoadError(error)) {
      try {
        if (!sessionStorage.getItem(CHUNK_RELOAD_FLAG)) {
          sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
          window.location.reload();
        }
      } catch {
        // sessionStorage may be unavailable (private mode / blocked) — fall
        // through to the manual reload fallback below.
      }
    }
  }

  private handleReload = () => {
    try {
      // Clear the one-shot guard so a manual reload always actually reloads.
      sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Не удалось загрузить страницу. Обновите её, чтобы продолжить.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Обновить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
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
              <Route path="/reset-password" component={ResetPasswordPage} />
              <Route path="/onboarding" component={OnboardingPage} />

              {/* Admin space */}
              <Route path="/admin" nest>
                <RoleGate allow={["admin"]}>
                  <ErrorBoundary>
                    <Suspense fallback={<PortalLoading />}>
                      <AdminRouter />
                    </Suspense>
                  </ErrorBoundary>
                </RoleGate>
              </Route>

              {/* Dispatcher space (Phase 4 P0) */}
              <Route path="/dispatch" nest>
                <RoleGate allow={["dispatcher"]}>
                  <ErrorBoundary>
                    <Suspense fallback={<PortalLoading />}>
                      <DispatchRouter />
                    </Suspense>
                  </ErrorBoundary>
                </RoleGate>
              </Route>

              {/* Driver space (Phase 4 P0 — реализовано) */}
              <Route path="/d" nest>
                <RoleGate allow={["driver"]}>
                  <ErrorBoundary>
                    <Suspense fallback={<PortalLoading />}>
                      <DriverRouter />
                    </Suspense>
                  </ErrorBoundary>
                </RoleGate>
              </Route>

              {/* Customer billing page — self-serve carrier owners (role 'driver').
                  Trial reminder emails + Stripe checkout return URLs point here. */}
              <Route path="/billing">
                <RoleGate allow={["driver"]}>
                  <ErrorBoundary>
                    <Suspense fallback={<PortalLoading />}>
                      <CustomerBillingPage />
                    </Suspense>
                  </ErrorBoundary>
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
  const { user, isLoading, isError } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user) {
      setLocation(defaultRouteForRole(user.role), { replace: true });
    }
  }, [user, isLoading, setLocation]);

  // Show the spinner while auth resolves, while a logged-in user is redirected,
  // OR while /api/me is in a transient error state (5xx/network/CORS) with no
  // cached user. use-auth distinguishes a real logged-out 401/403 (→ user:null,
  // isError:false) from a transient failure (→ isError:true) and auto-retries,
  // so we must NOT flash the marketing landing at a possibly-logged-in user on a
  // momentary blip — keep the spinner until the retry resolves to a real answer.
  if (isLoading || user || isError) {
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
