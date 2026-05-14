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
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import ForgotPasswordPage from "@/pages/forgot-password";
import NotFound from "@/pages/not-found";
import { AdminShell } from "@/pages/admin/_shell";
import LegacyDashboardPage from "@/pages/admin/legacy-dashboard";
import DashboardPage from "@/pages/admin/dashboard";
import UsersPage from "@/pages/admin/users";
import AssignmentsPage from "@/pages/admin/assignments";
import ClientsPage from "@/pages/admin/clients";
import LoadsPage from "@/pages/admin/loads";
import BrokersPage from "@/pages/admin/brokers";
import DocumentsPage from "@/pages/admin/documents";
import AuditPage from "@/pages/admin/audit";
import BackupPage from "@/pages/admin/backup";
import BillingPage from "@/pages/admin/billing";
import SettingsPage from "@/pages/admin/settings";

/**
 * Single entry-point for the whole web app.
 *
 * - Router uses hash-based location (main.tsx initialises window.location.hash
 *   to "#/"). This keeps the deployable static-host friendly.
 * - Three top-level role spaces: /admin/*, /dispatch/*, /me/*. Each is
 *   guarded by <RoleGate>. Unauthenticated users get bounced to /login;
 *   wrong-role users get bounced to their portal's home (silent).
 * - "/" is a smart redirect: logged-in → defaultRouteForRole;
 *   not logged-in → /login.
 *
 * Phase 2 deliverable scope:
 *   - All public pages implemented
 *   - Admin shell + RoleGate in place
 *   - All 11 /admin/* screens are placeholders here (filled in part 2 of
 *     Phase 2)
 *   - /admin/legacy-dashboard keeps the v1.2.7 monolith alive until Phase 3
 *   - /dispatch/* and /me/* render a stub for the next AI to replace
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={150}>
          <Router hook={useHashLocation}>
            <Switch>
              {/* Public auth pages */}
              <Route path="/login" component={LoginPage} />
              <Route path="/signup" component={SignupPage} />
              <Route path="/forgot-password" component={ForgotPasswordPage} />

              {/* Admin space */}
              <Route path="/admin" nest>
                <RoleGate allow={["admin"]}>
                  <AdminRouter />
                </RoleGate>
              </Route>

              {/* Dispatcher space (stub for Phase 4 AI) */}
              <Route path="/dispatch" nest>
                <RoleGate allow={["dispatcher"]}>
                  <PortalStub
                    portalName="Dispatcher Portal"
                    note="Будет реализован в Phase 4 третьим ИИ. Дизайн-система готова и совместима."
                  />
                </RoleGate>
              </Route>

              {/* Driver space (stub for Phase 4 AI) */}
              <Route path="/me" nest>
                <RoleGate allow={["driver"]}>
                  <PortalStub
                    portalName="Driver Portal"
                    note="Будет реализован в Phase 4 третьим ИИ. Дизайн-система готова и совместима."
                  />
                </RoleGate>
              </Route>

              {/* Root redirect */}
              <Route path="/" component={RootRedirect} />

              {/* 404 */}
              <Route component={NotFound} />
            </Switch>
          </Router>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
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
        <Route path="/assignments" component={AssignmentsPage} />
        <Route path="/clients" component={ClientsPage} />
        <Route path="/loads" component={LoadsPage} />
        <Route path="/brokers" component={BrokersPage} />
        <Route path="/documents" component={DocumentsPage} />
        <Route path="/audit" component={AuditPage} />
        <Route path="/backup" component={BackupPage} />
        <Route path="/billing" component={BillingPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/legacy-dashboard" component={LegacyDashboardPage} />
        <Route component={NotFound} />
      </Switch>
    </AdminShell>
  );
}

function RootRedirect() {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    setLocation(user ? defaultRouteForRole(user.role) : "/login");
  }, [user, isLoading, setLocation]);

  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function PortalStub({ portalName, note }: { portalName: string; note: string }) {
  const { user } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="max-w-md space-y-3 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">{portalName}</h1>
        <p className="text-sm text-muted-foreground">{note}</p>
        <div className="pt-3 text-xs text-muted-foreground">
          Вошли как {user?.fullName} ({user?.email})
        </div>
      </div>
    </div>
  );
}
