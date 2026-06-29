import { Route, Switch } from "wouter";
import { DispatchShell } from "@/pages/dispatch/_shell";
import NotFound from "@/pages/not-found";
import DispatchDashboardPage from "@/pages/dispatch/dashboard";
import DispatchClientsPage from "@/pages/dispatch/clients";
import DispatchLoadsPage from "@/pages/dispatch/loads";
import DispatchLoadDetailPage from "@/pages/dispatch/load-detail";
import DispatchQueuePage from "@/pages/dispatch/queue";
import DispatchCockpitPage from "@/pages/dispatch/cockpit";
import DispatchPredictionsPage from "@/pages/dispatch/predictions";

/**
 * DispatchRouter — routes inside the /dispatch space. Lazy-loaded by App.tsx
 * (own chunk). Paths relative to /dispatch. The shell wraps all dispatch screens
 * in the emerald (.theme-jade) override.
 */
export default function DispatchRouter() {
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
