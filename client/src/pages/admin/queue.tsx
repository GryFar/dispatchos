import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Loader2,
  Truck,
  User,
  XCircle,
} from "lucide-react";
import type {
  ApprovalTask,
  ApprovalTaskStatus,
  ApprovalTaskType,
} from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useT } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { formatDateFull, formatRelativeAgo } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/dispatch/EmptyState";

/**
 * Admin queue (`/admin/queue`) — Phase 4 P1.1.
 *
 * Lists approval_tasks created by drivers / dispatchers / system, with
 * resolve/dismiss actions. Default view: open tasks. Drivers report
 * problems through POST /api/me/issues which lands here.
 *
 * No pagination UI for v1 — issue volume is low; the API supports cursor
 * and `total`, the sidebar badge consumes `total`. Add Load More if/when
 * volume justifies.
 */

type ApprovalTaskEnriched = ApprovalTask & {
  createdByEmail: string | null;
  createdByFullName: string | null;
  resolvedByEmail: string | null;
};

interface ListResponse {
  items: ApprovalTaskEnriched[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

const STATUS_TABS: Array<{ value: ApprovalTaskStatus | "all"; labelKey: string }> = [
  { value: "open", labelKey: "admin.queue.tabOpen" },
  { value: "resolved", labelKey: "admin.queue.tabResolved" },
  { value: "dismissed", labelKey: "admin.queue.tabDismissed" },
  { value: "all", labelKey: "admin.queue.tabAll" },
];

const TASK_TYPE_LABEL_KEYS: Record<ApprovalTaskType, string> = {
  driver_issue: "admin.queue.typeDriverIssue",
  driver_booking_request: "admin.queue.typeDriverBookingRequest",
  signup_lead: "admin.queue.typeSignupLead",
};

const SEVERITY_META: Record<
  string,
  { labelKey: string; cls: string; icon: typeof AlertTriangle }
> = {
  info: {
    labelKey: "admin.queue.severityInfo",
    cls: "bg-blue-500/15 text-blue-500 border-blue-500/30",
    icon: AlertTriangle,
  },
  warn: {
    labelKey: "admin.queue.severityWarn",
    cls: "bg-yellow-500/15 text-yellow-600 border-yellow-500/40",
    icon: AlertTriangle,
  },
  urgent: {
    labelKey: "admin.queue.severityUrgent",
    cls: "bg-destructive/15 text-destructive border-destructive/40",
    icon: AlertTriangle,
  },
};

export default function QueuePage() {
  const { t } = useT();
  const [status, setStatus] = useState<ApprovalTaskStatus | "all">("open");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    params.set("limit", "100");
    return `/api/admin/approval-tasks?${params.toString()}`;
  }, [status]);

  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: [query],
    queryFn: () => apiJson("GET", query),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("admin.queue.breadcrumb")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.queue.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.queue.subtitle")}
        </p>
      </header>

      <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)}>
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      ) : !data || data.items.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title={status === "open" ? t("admin.queue.emptyOpenTitle") : t("admin.queue.emptyTitle")}
            description={
              status === "open"
                ? t("admin.queue.emptyOpenDescription")
                : t("admin.queue.emptyDescription")
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {data.items.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: ApprovalTaskEnriched }) {
  const { t } = useT();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [resolution, setResolution] = useState("");

  const mutation = useMutation({
    mutationFn: (vars: { action: "resolve" | "dismiss"; resolution?: string }) =>
      apiJson("PATCH", `/api/admin/approval-tasks/${task.id}`, vars),
    onSuccess: (_, vars) => {
      toast({
        title: vars.action === "resolve" ? t("admin.queue.statusResolved") : t("admin.queue.statusDismissed"),
      });
      qc.invalidateQueries({ queryKey: ["/api/admin/approval-tasks", "open-count"] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/approval-tasks") });
      setResolveOpen(false);
      setDismissOpen(false);
      setResolution("");
    },
    onError: (err: ApiError) =>
      toast({ variant: "destructive", title: t("admin.queue.actionFailed"), description: err.message }),
  });

  // Pull common payload fields out (driver_issue payload shape).
  const payload = task.payload as {
    severity?: string;
    title?: string;
    description?: string;
    loadId?: string | null;
    reporterUserId?: string;
    resolution?: string;
  };
  const sev = payload.severity && SEVERITY_META[payload.severity];
  const isOpen = task.status === "open" || task.status === "in_progress";

  return (
    <Card className="space-y-3 p-4">
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {TASK_TYPE_LABEL_KEYS[task.taskType] ? t(TASK_TYPE_LABEL_KEYS[task.taskType]) : task.taskType}
            </span>
            {sev && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sev.cls}`}
              >
                <sev.icon className="h-3 w-3" />
                {t(sev.labelKey)}
              </span>
            )}
            <StatusChip status={task.status} />
          </div>
          {payload.title && (
            <p className="mt-1.5 text-sm font-semibold">{payload.title}</p>
          )}
          {payload.description && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {payload.description}
            </p>
          )}
        </div>

        {isOpen && (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDismissOpen(true)}
              disabled={mutation.isPending}
            >
              <XCircle className="mr-1.5 h-3.5 w-3.5" />
              {t("admin.queue.dismissAction")}
            </Button>
            <Button
              size="sm"
              onClick={() => setResolveOpen(true)}
              disabled={mutation.isPending}
            >
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              {t("admin.queue.resolveAction")}
            </Button>
          </div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <User className="h-3.5 w-3.5" />
          {task.createdByFullName || task.createdByEmail || task.createdByUserId}
        </span>
        <span title={formatDateFull(task.createdAt)}>
          {formatRelativeAgo(task.createdAt)}
        </span>
        {payload.loadId && (
          <span className="inline-flex items-center gap-1">
            <Truck className="h-3.5 w-3.5" />
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              {payload.loadId}
            </code>
          </span>
        )}
      </div>

      {/* Resolution note (if terminated) */}
      {!isOpen && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <p className="font-medium">
            {task.status === "resolved" ? t("admin.queue.statusResolved") : t("admin.queue.statusDismissed")}
            {task.resolvedByEmail && ` — ${task.resolvedByEmail}`}
            {task.resolvedAt && ` · ${formatRelativeAgo(task.resolvedAt)}`}
          </p>
          {payload.resolution && (
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {payload.resolution}
            </p>
          )}
        </div>
      )}

      {/* Resolve dialog */}
      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.queue.resolveDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("admin.queue.resolveDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="resolution">{t("admin.queue.noteLabel")}</Label>
            <Textarea
              id="resolution"
              value={resolution}
              maxLength={1000}
              onChange={(e) => setResolution(e.target.value)}
              placeholder={t("admin.queue.resolvePlaceholder")}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() =>
                mutation.mutate({ action: "resolve", resolution: resolution || undefined })
              }
              disabled={mutation.isPending}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("admin.queue.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dismiss dialog */}
      <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.queue.dismissDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("admin.queue.dismissDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dismiss-reason">{t("admin.queue.reasonLabel")}</Label>
            <Textarea
              id="dismiss-reason"
              value={resolution}
              maxLength={1000}
              onChange={(e) => setResolution(e.target.value)}
              placeholder={t("admin.queue.dismissPlaceholder")}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                mutation.mutate({ action: "dismiss", resolution: resolution || undefined })
              }
              disabled={mutation.isPending}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("admin.queue.dismissAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function StatusChip({ status }: { status: ApprovalTaskStatus }) {
  const { t } = useT();
  const map: Record<ApprovalTaskStatus, { labelKey: string; cls: string }> = {
    open: { labelKey: "admin.queue.statusOpen", cls: "bg-primary/15 text-primary" },
    in_progress: { labelKey: "admin.queue.statusInProgress", cls: "bg-blue-500/15 text-blue-500" },
    resolved: { labelKey: "admin.queue.statusResolved", cls: "bg-emerald-500/15 text-emerald-600" },
    dismissed: { labelKey: "admin.queue.statusDismissed", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${m.cls}`}
    >
      {t(m.labelKey)}
    </span>
  );
}
