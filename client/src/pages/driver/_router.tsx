import { Route, Switch } from "wouter";
import { DriverShell } from "@/pages/driver/_shell";
import NotFound from "@/pages/not-found";
import DriverDashboardPage from "@/pages/driver/dashboard";
import DriverLoadsListPage from "@/pages/driver/loads-list";
import DriverLoadDetailPage from "@/pages/driver/load-detail";
import DriverDocumentsPage from "@/pages/driver/documents";
import DriverProfilePage from "@/pages/driver/profile";
import DriverLoadCreatePage from "@/pages/driver/load-create";

/**
 * DriverRouter — routes inside the /d space. Lazy-loaded by App.tsx (own chunk)
 * so a driver on a phone downloads only driver code. Paths relative to /d. The
 * shell wraps all driver screens in the orange theme override + bottom nav.
 */
export default function DriverRouter() {
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
