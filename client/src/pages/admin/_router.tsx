import { Route, Switch } from "wouter";
import { AdminShell } from "@/pages/admin/_shell";
import NotFound from "@/pages/not-found";
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

/**
 * AdminRouter — routes inside the /admin space. Lazy-loaded by App.tsx so the
 * admin portal (the biggest, ~20 pages) is its own chunk and never ships to the
 * driver/dispatcher first paint. Paths here are relative to /admin (parent
 * <Route path="/admin" nest>).
 */
export default function AdminRouter() {
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
