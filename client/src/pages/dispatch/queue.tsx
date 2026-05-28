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
import { useT } from "@/lib/i18n";

/**
 * /dispatch/queue — dispatcher's approval-task inbox. Same UX as
 * /admin/queue but consumes /api/dispatch/approval-tasks (filtered to
 * tasks routed via payload.dispatcherUserId).
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

export default function DispatchQueuePage() {
  const { t } = useT();
  const [status, setStatus] = useState<ApprovalTaskStatus | "all">("open");

  const STATUS_TABS: Array<{ value: ApprovalTaskStatus | "all"; labelKey: string }> = [
    { value: "open", labelKey: "dispatch.queue.tab.open" },
    { value: "resolved", labelKey: "dispatch.queue.tab.resolved" },
    { value: "dismissed", labelKey: "dispatch.queue.tab.dismissed" },
    { value: "all", labelKey: "dispatch.queue.tab.all" },
  ];

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    params.set("limit", "100");
    return `/api/dispatch/approval-tasks?${params.toString()}`;
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
          {t("dispatch.queue.header_sub")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("dispatch.queue.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("dispatch.queue.subtitle")}
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
            title={status === "open" ? t("dispatch.queue.empty_open") : t("dispatch.queue.empty_other")}
            description={
              status === "open"
                ? t("dispatch.queue.empty_open_desc")
                : t("dispatch.queue.empty_other_desc")
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

  const TASK_TYPE_LABELS: Record<ApprovalTaskType, string> = {
    driver_issue: t("dispatch.queue.task_type.driver_issue"),
    driver_booking_request: t("dispatch.queue.task_type.driver_booking_request"),
    signup_lead: t("dispatch.queue.task_type.signup_lead"),
  };

  const SEVERITY_META: Record<
    string,
    { label: string; cls: string; icon: typeof AlertTriangle }
  > = {
    info: {
      label: t("dispatch.queue.severity.info"),
      cls: "bg-blue-500/15 text-blue-500 border-blue-500/30",
      icon: AlertTriangle,
    },
    warn: {
      label: t("dispatch.queue.severity.warn"),
      cls: "bg-yellow-500/15 text-yellow-600 border-yellow-500/40",
      icon: AlertTriangle,
    },
    urgent: {
      label: t("dispatch.queue.severity.urgent"),
      cls: "bg-destructive/15 text-destructive border-destructive/40",
      icon: AlertTriangle,
    },
  };

  const mutation = useMutation({
    mutationFn: (vars: { action: "resolve" | "dismiss"; resolution?: string }) =>
      apiJson("PATCH", `/api/dispatch/approval-tasks/${task.id}`, vars),
    onSuccess: (_, vars) => {
      toast({
        title: vars.action === "resolve" ? t("dispatch.queue.resolved") : t("dispatch.queue.dismissed"),
      });
      qc.invalidateQueries({
        queryKey: ["/api/dispatch/approval-tasks", "open-count"],
      });
      qc.invalidateQueries({
        predicate: (q) =>
          String(q.queryKey[0]).startsWith("/api/dispatch/approval-tasks"),
      });
      setResolveOpen(false);
      setDismissOpen(false);
      setResolution("");
    },
    onError: (err: ApiError) =>
      toast({ variant: "destructive", title: t("dispatch.queue.action_failed"), description: err.message }),
  });

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {TASK_TYPE_LABELS[task.taskType] ?? task.taskType}
            </span>
            {sev && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sev.cls}`}
              >
                <sev.icon className="h-3 w-3" />
                {sev.label}
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
              {t("dispatch.queue.btn.dismiss")}
            </Button>
            <Button
              size="sm"
              onClick={() => setResolveOpen(true)}
              disabled={mutation.isPending}
            >
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              {t("dispatch.queue.btn.resolve")}
            </Button>
          </div>
        )}
      </div>

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

      {!isOpen && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <p className="font-medium">
            {task.status === "resolved" ? t("dispatch.queue.resolved") : t("dispatch.queue.dismissed")}
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

      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dispatch.queue.resolve_dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("dispatch.queue.resolve_dialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="resolution">{t("dispatch.queue.resolve_dialog.note")}</Label>
            <Textarea
              id="resolution"
              value={resolution}
              maxLength={1000}
              onChange={(e) => setResolution(e.target.value)}
              placeholder={t("dispatch.queue.resolve_dialog.placeholder")}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() =>
                mutation.mutate({
                  action: "resolve",
                  resolution: resolution || undefined,
                })
              }
              disabled={mutation.isPending}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("dispatch.queue.resolve_dialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dispatch.queue.dismiss_dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("dispatch.queue.dismiss_dialog.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dismiss-reason">{t("dispatch.queue.dismiss_dialog.reason")}</Label>
            <Textarea
              id="dismiss-reason"
              value={resolution}
              maxLength={1000}
              onChange={(e) => setResolution(e.target.value)}
              placeholder={t("dispatch.queue.dismiss_dialog.placeholder")}
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
                mutation.mutate({
                  action: "dismiss",
                  resolution: resolution || undefined,
                })
              }
              disabled={mutation.isPending}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("dispatch.queue.btn.dismiss")}
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
    open: { labelKey: "dispatch.queue.status.open", cls: "bg-primary/15 text-primary" },
    in_progress: { labelKey: "dispatch.queue.status.in_progress", cls: "bg-blue-500/15 text-blue-500" },
    resolved: { labelKey: "dispatch.queue.status.resolved", cls: "bg-emerald-500/15 text-emerald-600" },
    dismissed: { labelKey: "dispatch.queue.status.dismissed", cls: "bg-muted text-muted-foreground" },
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
