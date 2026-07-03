import { Route, Switch } from "wouter";
import { DriverShell } from "@/pages/driver/_shell";
import NotFound from "@/pages/not-found";
import DriverDashboardPage from "@/pages/driver/dashboard";
import DriverLoadsListPage from "@/pages/driver/loads-list";
import DriverLoadDetailPage from "@/pages/driver/load-detail";
import DriverDocumentsPage from "@/pages/driver/documents";
import DriverProfilePage from "@/pages/driver/profile";
import DriverLoadCreatePage from "@/pages/driver/load-create";
import OwnerBoardPage from "@/pages/driver/owner-board";
import OwnerBrokerCheckPage from "@/pages/driver/owner-broker-check";
import OwnerDetentionPage from "@/pages/driver/owner-detention";
import OwnerIftaPage from "@/pages/driver/owner-ifta";

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
        {/* WAVE B — owner-operator-only tools. The server gates each backing
            /api/me/* endpoint to owner-operators (403 otherwise); the entry
            points on the dashboard only render for owner-operators, so a hired
            driver never discovers or reaches these routes. */}
        <Route path="/owner/board" component={OwnerBoardPage} />
        <Route path="/owner/broker-check" component={OwnerBrokerCheckPage} />
        <Route path="/owner/detention" component={OwnerDetentionPage} />
        <Route path="/owner/ifta" component={OwnerIftaPage} />
        <Route component={NotFound} />
      </Switch>
    </DriverShell>
  );
}
