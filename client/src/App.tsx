import { useEffect } from "react";
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
import { AdminShell } from "@/pages/admin/_shell";
import LegacyDashboardPage from "@/pages/admin/legacy-dashboard";
import DashboardPage from "@/pages/admin/dashboard";
import UsersPage from "@/pages/admin/users";
import AssignmentsPage from "@/pages/admin/assignments";
import ClientsPage from "@/pages/admin/clients";
import LoadsPage from "@/pages/admin/loads";
import AdminLoadDetailPage from "@/pages/admin/load-detail";
import BrokersPage from "@/pages/admin/brokers";
import DocumentsPage from "@/pages/admin/documents";
import QueuePage from "@/pages/admin/queue";
import AuditPage from "@/pages/admin/audit";
import BackupPage from "@/pages/admin/backup";
import BillingPage from "@/pages/admin/billing";
import BillingStripePage from "@/pages/admin/billing-stripe";
import SettingsPage from "@/pages/admin/settings";
import IntegrationsPage from "@/pages/admin/integrations";
import EmailInboxPage from "@/pages/admin/email-inbox";
import ClientDetailPage from "@/pages/admin/client-detail";
import UserDetailPage from "@/pages/admin/user-detail";
import LoadSourcesPage from "@/pages/admin/load-sources";
import LoadSourceNewPage from "@/pages/admin/load-source-new";
import LoadSourceDetailPage from "@/pages/admin/load-source-detail";

// Phase 4 P0 — driver portal at /d/*
import { DriverShell } from "@/pages/driver/_shell";
import DriverDashboardPage from "@/pages/driver/dashboard";
import DriverLoadsListPage from "@/pages/driver/loads-list";
import DriverLoadDetailPage from "@/pages/driver/load-detail";
import DriverDocumentsPage from "@/pages/driver/documents";
import DriverProfilePage from "@/pages/driver/profile";
import DriverLoadCreatePage from "@/pages/driver/load-create";
// Phase 4 P0 — dispatcher portal at /dispatch/*
import { DispatchShell } from "@/pages/dispatch/_shell";
import DispatchDashboardPage from "@/pages/dispatch/dashboard";
import DispatchClientsPage from "@/pages/dispatch/clients";
import DispatchLoadsPage from "@/pages/dispatch/loads";
import DispatchLoadDetailPage from "@/pages/dispatch/load-detail";
import DispatchQueuePage from "@/pages/dispatch/queue";
import DispatchCockpitPage from "@/pages/dispatch/cockpit";
import DispatchPredictionsPage from "@/pages/dispatch/predictions";

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
 * Single entry-point for the whole web app.
 *
 * - Router uses hash-based location (main.tsx initialises window.location.hash
 *   to "#/"). This keeps the deployable static-host friendly.
 * - Three top-level role spaces: /admin/*, /dispatch/*, /d/*. Each is
 *   guarded by <RoleGate>. Unauthenticated users get bounced to /login;
 *   wrong-role users get bounced to their portal's home (silent).
 * - "/" is a smart root: anonymous visitors see the marketing landing;
 *   logged-in users are redirected to their portal home (defaultRouteForRole).
 *
 * Phase 4 P0 scope:
 *   - Driver portal /d/* реализован (dashboard, loads, load detail,
 *     documents stub, profile). API: /api/me/* (server/routes/me.ts).
 *   - Dispatcher portal /dispatch/* реализован (dashboard, clients, loads,
 *     cockpit, queue, predictions). API: /api/dispatch/* (server/routes/dispatch.ts).
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
                  <AdminRouter />
                </RoleGate>
              </Route>

              {/* Dispatcher space (Phase 4 P0) */}
              <Route path="/dispatch" nest>
                <RoleGate allow={["dispatcher"]}>
                  <DispatchRouter />
                </RoleGate>
              </Route>

              {/* Driver space (Phase 4 P0 — реализовано) */}
              <Route path="/d" nest>
                <RoleGate allow={["driver"]}>
                  <DriverRouter />
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
 * AdminRouter — routes inside the /admin space. Because the parent
 * <Route path="/admin" nest>, paths here are relative to /admin.
 */
function AdminRouter() {
  return (
    <AdminShell>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/users" component={UsersPage} />
        <Route path="/users/:id" component={UserDetailPage} />
        <Route path="/assignments" component={AssignmentsPage} />
        <Route path="/clients" component={ClientsPage} />
        <Route path="/clients/:id" component={ClientDetailPage} />
        <Route path="/loads" component={LoadsPage} />
        <Route path="/loads/:id" component={AdminLoadDetailPage} />
        <Route path="/brokers" component={BrokersPage} />
        <Route path="/documents" component={DocumentsPage} />
        <Route path="/queue" component={QueuePage} />
        <Route path="/audit" component={AuditPage} />
        <Route path="/backup" component={BackupPage} />
        <Route path="/billing" component={BillingStripePage} />
        <Route path="/invoicing" component={BillingPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/legacy-dashboard" component={LegacyDashboardPage} />
        <Route path="/integrations" component={IntegrationsPage} />
        <Route path="/load-sources" component={LoadSourcesPage} />
        <Route path="/load-sources/new" component={LoadSourceNewPage} />
        <Route path="/load-sources/:id" component={LoadSourceDetailPage} />
        <Route path="/email-inbox" component={EmailInboxPage} />
        <Route component={NotFound} />
      </Switch>
    </AdminShell>
  );
}

/**
 * DriverRouter — routes inside the /d space. Paths relative to /d.
 * Phase 4 P0. The shell wraps all driver screens in the orange theme
 * override and provides the bottom nav.
 */
function DriverRouter() {
  return (
    <DriverShell>
      <Switch>
        <Route path="/" component={DriverDashboardPage} />
        <Route path="/loads/new" component={DriverLoadCreatePage} />
        <Route path="/loads" component={DriverLoadsListPage} />
        <Route path="/loads/:id" component={DriverLoadDetailPage} />
        <Route path="/documents" component={DriverDocumentsPage} />
        <Route path="/profile" component={DriverProfilePage} />
        <Route component={NotFound} />
      </Switch>
    </DriverShell>
  );
}

/**
 * DispatchRouter — routes inside the /dispatch space. Paths relative to
 * /dispatch. Phase 4 P0 dispatcher portal. The shell wraps all dispatch
 * screens in the emerald (.theme-jade) override.
 */
function DispatchRouter() {
  return (
    <DispatchShell>
      <Switch>
        <Route path="/" component={DispatchDashboardPage} />
        <Route path="/clients" component={DispatchClientsPage} />
        <Route path="/loads" component={DispatchLoadsPage} />
        <Route path="/loads/:id" component={DispatchLoadDetailPage} />
        <Route path="/cockpit" component={DispatchCockpitPage} />
        <Route path="/queue" component={DispatchQueuePage} />
        <Route path="/predictions" component={DispatchPredictionsPage} />
        <Route component={NotFound} />
      </Switch>
    </DispatchShell>
  );
}

/**
 * Smart root route for "/".
 * - while auth is resolving: a spinner (avoids flashing the landing then yanking
 *   it away).
 * - logged-in: redirect to the role's portal home (replace, so Back doesn't trap
 *   the user on "/").
 * - anonymous: the public marketing landing.
 *
 * Previously "/" rendered <LandingPage> unconditionally, so authenticated users
 * who hit the root saw marketing instead of their dashboard.
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
