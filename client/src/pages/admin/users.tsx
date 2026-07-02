import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Client } from "@shared/schema";
import { z } from "zod";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Lock,
  Mail,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  ShieldOff,
  ShieldCheck,
  Trash2,
  Unlock,
  Users as UsersIcon,
} from "lucide-react";
import type {
  CreateInviteInput,
  Invite,
  UserPublic,
  UserRole,
} from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useT, tr } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { useClipboard } from "@/lib/use-clipboard";
import { formatDateFull, formatRelativeAgo } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/dispatch/DataTable";
import { RoleBadge } from "@/components/dispatch/RoleBadge";
import { StatusBadge } from "@/components/dispatch/StatusBadge";
import { EmptyState } from "@/components/dispatch/EmptyState";
import { EndpointPending, isEndpointMissing } from "@/components/dispatch/EndpointPending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";

type UserListResponse = {
  items: UserPublic[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
};

type InviteListResponse = {
  items: Invite[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
};

/**
 * Users page — single most important admin screen.
 *
 * Two tabs: Users + Invites (active invites that haven't been consumed yet).
 *
 * Actions (per user):
 *   - Reset password → modal w/ temp password + copy button
 *   - Reset TOTP → modal w/ new QR + secret
 *   - Block / Unblock
 *
 * Top action: Create invite → modal w/ form → success modal w/ code, signup URL, copy.
 *
 * All endpoints are Phase 3 (P0/P1 priorities). UI ловит 404 и показывает
 * <EndpointPending> на месте таблиц. Когда бэкендер выкатит — таблицы оживут.
 */
export default function UsersPage() {
  const { t } = useT();
  const [tab, setTab] = useState<"users" | "invites">("users");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("admin.users.breadcrumb")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("admin.users.title")}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t("admin.users.subtitle")}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("admin.users.createInvite")}
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="users">{t("admin.users.title")}</TabsTrigger>
          <TabsTrigger value="invites">{t("admin.users.activeInvites")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "users" ? <UsersTab /> : <InvitesTab />}

      <CreateInviteDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

// ===========================================================================
// USERS TAB
// ===========================================================================

function UsersTab() {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | UserRole>("all");
  const [blockedFilter, setBlockedFilter] = useState<"all" | "active" | "blocked">("all");

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (blockedFilter !== "all") params.set("blocked", blockedFilter === "blocked" ? "true" : "false");
    params.set("limit", "50");
    return `/api/admin/users?${params.toString()}`;
  }, [q, roleFilter, blockedFilter]);

  const { data, isLoading, error } = useQuery<UserListResponse>({
    queryKey: [queryUrl],
    queryFn: () => apiJson<UserListResponse>("GET", queryUrl),
    staleTime: 30_000,
  });

  if (isEndpointMissing(error)) {
    return (
      <EndpointPending
        endpoint="GET /api/admin/users"
        description={t("admin.users.endpointPendingUsers")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("admin.users.searchPlaceholder")}
            className="pl-9"
          />
        </div>
        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as typeof roleFilter)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue placeholder={t("admin.users.allRoles")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin.users.allRoles")}</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="dispatcher">{t("admin.users.roleDispatcher")}</SelectItem>
            <SelectItem value="driver">{t("admin.users.roleDriver")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={blockedFilter} onValueChange={(v) => setBlockedFilter(v as typeof blockedFilter)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue placeholder={t("admin.users.allShort")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin.users.allStatuses")}</SelectItem>
            <SelectItem value="active">{t("admin.users.statusActivePlural")}</SelectItem>
            <SelectItem value="blocked">{t("admin.users.statusBlockedPlural")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <UsersTable rows={data?.items ?? []} loading={isLoading} error={error as Error | null} />

      {data && data.total != null && (
        <p className="text-xs text-muted-foreground">
          {t("admin.users.totalCount", { count: data.total })}{data.hasMore ? t("admin.users.firstShown") : ""}
        </p>
      )}
    </div>
  );
}

function UsersTable({ rows, loading, error }: { rows: UserPublic[]; loading: boolean; error: Error | null }) {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const [resetPwUser, setResetPwUser] = useState<UserPublic | null>(null);
  const [resetTotpUser, setResetTotpUser] = useState<UserPublic | null>(null);

  // Online presence — refetch every 30s so the 🟢 dot is near-realtime.
  // We pull just the id set (cheap) and intersect it with the table rows.
  const presenceQ = useQuery<{ minutes: number; onlineUserIds: string[] }>({
    queryKey: ["/api/admin/presence"],
    queryFn: () => apiJson("GET", "/api/admin/presence?minutes=2"),
    refetchInterval: 30_000,
  });
  const onlineSet = useMemo(
    () => new Set(presenceQ.data?.onlineUserIds ?? []),
    [presenceQ.data?.onlineUserIds],
  );

  const columns: DataTableColumn<UserPublic>[] = [
    {
      key: "name",
      header: t("admin.users.colUser"),
      cell: (u) => {
        const online = onlineSet.has(u.id);
        return (
          <div className="flex items-center gap-2.5">
            <div className="relative shrink-0">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {u.fullName?.[0]?.toUpperCase() ?? "?"}
              </span>
              {online && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-success"
                  title={t("admin.users.online")}
                />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium">{u.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{u.email}</p>
            </div>
          </div>
        );
      },
    },
    {
      key: "role",
      header: t("admin.users.colRole"),
      cell: (u) => <RoleBadge role={u.role} />,
      width: "140px",
    },
    {
      key: "status",
      header: t("admin.users.colStatus"),
      cell: (u) =>
        u.blocked ? (
          <StatusBadge variant="blocked" dot>{t("admin.users.statusBlocked")}</StatusBadge>
        ) : (
          <StatusBadge variant="active" dot>{t("admin.users.statusActive")}</StatusBadge>
        ),
      width: "150px",
    },
    {
      key: "2fa",
      header: "2FA",
      cell: (u) =>
        u.twoFactorEnabled ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <ShieldCheck className="h-3.5 w-3.5" /> {t("admin.users.enabled")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldOff className="h-3.5 w-3.5" /> {t("admin.users.disabled")}
          </span>
        ),
      width: "120px",
      hideOnMobile: true,
    },
    {
      key: "presence",
      header: t("admin.users.colActivity"),
      cell: (u) => {
        const online = onlineSet.has(u.id);
        if (online) {
          return (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <span className="h-2 w-2 rounded-full bg-success" />
              {t("admin.users.online")}
            </span>
          );
        }
        if (u.lastSeenAt) {
          return (
            <span
              className="text-xs text-muted-foreground"
              title={formatDateFull(u.lastSeenAt)}
            >
              {formatRelativeAgo(u.lastSeenAt)}
            </span>
          );
        }
        if (u.lastLoginAt) {
          return (
            <span
              className="text-xs text-muted-foreground"
              title={t("admin.users.lastLoginTitle", { date: formatDateFull(u.lastLoginAt) })}
            >
              {t("admin.users.loginAgo", { ago: formatRelativeAgo(u.lastLoginAt) })}
            </span>
          );
        }
        return <span className="text-xs text-muted-foreground">{t("admin.users.neverLoggedIn")}</span>;
      },
      width: "160px",
      hideOnMobile: true,
    },
    {
      // Henry QA Bug #5 — show truck unit number for driver rows.
      key: "unitNumber",
      header: "Unit #",
      cell: (u) =>
        u.role === "driver" ? (
          <span className="font-mono text-xs">
            {(u as any).unitNumber ?? <span className="text-muted-foreground">—</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      width: "90px",
      hideOnMobile: true,
    },
    {
      key: "actions",
      header: "",
      cell: (u) => (
        <UserActionsMenu
          user={u}
          onResetPassword={() => setResetPwUser(u)}
          onResetTotp={() => setResetTotpUser(u)}
        />
      ),
      width: "60px",
      align: "right",
    },
  ];

  if (error && !isEndpointMissing(error)) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("admin.users.loadFailed", { message: error.message })}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        onRowClick={(u) => setLocation(`/users/${u.id}`)}
        empty={
          <EmptyState
            icon={<UsersIcon />}
            title={t("admin.users.emptyTitle")}
            description={t("admin.users.emptyDesc")}
          />
        }
      />

      {resetPwUser && (
        <ResetPasswordDialog
          user={resetPwUser}
          onClose={() => setResetPwUser(null)}
        />
      )}
      {resetTotpUser && (
        <ResetTotpDialog
          user={resetTotpUser}
          onClose={() => setResetTotpUser(null)}
        />
      )}
    </>
  );
}

function UserActionsMenu({
  user,
  onResetPassword,
  onResetTotp,
}: {
  user: UserPublic;
  onResetPassword: () => void;
  onResetTotp: () => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const blockMutation = useMutation({
    mutationFn: () =>
      apiJson<UserPublic>("PATCH", `/api/admin/users/${user.id}`, { blocked: !user.blocked }),
    onSuccess: () => {
      // Invalidate all user-list queries (keyed by the full filtered URL, so a
      // plain ["/api/admin/users"] array key would never partial-match them).
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/users") });
      toast({
        title: user.blocked ? t("admin.users.unblockedToast") : t("admin.users.blockedToast"),
        description: user.fullName,
      });
    },
    onError: (err: Error) => {
      toast({
        variant: "destructive",
        title: t("common.error"),
        description: err.message,
      });
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 shadow-pop">
        <DropdownMenuItem onClick={onResetPassword}>
          <KeyRound className="mr-2 h-4 w-4" /> {t("admin.users.resetPassword")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onResetTotp}>
          <Lock className="mr-2 h-4 w-4" /> {t("admin.users.reset2fa")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {user.blocked ? (
          <DropdownMenuItem onClick={() => blockMutation.mutate()}>
            <Unlock className="mr-2 h-4 w-4" /> {t("admin.users.unblock")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={() => blockMutation.mutate()}
            className="text-destructive focus:text-destructive"
          >
            <ShieldOff className="mr-2 h-4 w-4" /> {t("admin.users.block")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ===========================================================================
// INVITES TAB
// ===========================================================================

function InvitesTab() {
  const { t } = useT();
  const [statusFilter, setStatusFilter] = useState<"active" | "expired" | "consumed" | "all">("active");

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set("status", statusFilter);
    params.set("limit", "50");
    return `/api/admin/invites?${params.toString()}`;
  }, [statusFilter]);

  const { data, isLoading, error } = useQuery<InviteListResponse>({
    queryKey: [queryUrl],
    queryFn: () => apiJson<InviteListResponse>("GET", queryUrl),
    staleTime: 30_000,
  });

  if (isEndpointMissing(error)) {
    return (
      <EndpointPending
        endpoint="GET /api/admin/invites"
        description={t("admin.users.endpointPendingInvites")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t("admin.users.statusActivePlural")}</SelectItem>
            <SelectItem value="expired">{t("admin.users.inviteExpiredPlural")}</SelectItem>
            <SelectItem value="consumed">{t("admin.users.inviteConsumedPlural")}</SelectItem>
            <SelectItem value="all">{t("admin.users.allShort")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <InvitesTable rows={data?.items ?? []} loading={isLoading} error={error as Error | null} />
    </div>
  );
}

function InvitesTable({ rows, loading, error }: { rows: Invite[]; loading: boolean; error: Error | null }) {
  const { t } = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { copy } = useClipboard();

  const revokeMutation = useMutation({
    mutationFn: (code: string) => apiJson("DELETE", `/api/admin/invites/${encodeURIComponent(code)}`),
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/invites") });
      toast({ title: t("admin.users.inviteRevokedToast") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("common.error"), description: err.message });
    },
  });

  const columns: DataTableColumn<Invite>[] = [
    {
      key: "code",
      header: t("admin.users.colCode"),
      mono: true,
      cell: (inv) => <span>{inv.code}</span>,
    },
    {
      key: "role",
      header: t("admin.users.colRole"),
      cell: (inv) => <RoleBadge role={inv.role} />,
      width: "140px",
    },
    {
      key: "email",
      header: t("common.email"),
      cell: (inv) => inv.email ?? <span className="text-muted-foreground">{t("admin.users.inviteEmailAny")}</span>,
      hideOnMobile: true,
    },
    {
      key: "expires",
      header: t("admin.users.colExpires"),
      cell: (inv) => {
        const now = Date.now();
        const exp = new Date(inv.expiresAt).getTime();
        if (inv.consumedAt) {
          return <StatusBadge variant="default">{t("admin.users.inviteConsumed")}</StatusBadge>;
        }
        if (exp < now) {
          return <StatusBadge variant="default">{t("admin.users.inviteExpired")}</StatusBadge>;
        }
        return (
          <span className="text-xs text-muted-foreground" title={formatDateFull(inv.expiresAt)}>
            {t("admin.users.expiresIn", { time: formatRelativeAgo(inv.expiresAt).replace("ago", "").trim() || "—" })}
          </span>
        );
      },
      width: "140px",
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "120px",
      cell: (inv) => {
        const isActive = !inv.consumedAt && new Date(inv.expiresAt).getTime() > Date.now();
        if (!isActive) {
          return null;
        }
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={async () => {
                const ok = await copy(inv.code);
                toast({ title: ok ? t("admin.users.codeCopied") : t("admin.users.copyFailed") });
              }}
              aria-label={t("admin.users.copy")}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              onClick={() => revokeMutation.mutate(inv.code)}
              disabled={revokeMutation.isPending}
              aria-label={t("admin.users.revoke")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  if (error && !isEndpointMissing(error)) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("admin.users.loadFailed", { message: error.message })}</AlertDescription>
      </Alert>
    );
  }

  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      empty={
        <EmptyState
          icon={<Mail />}
          title={t("admin.users.invitesEmptyTitle")}
          description={t("admin.users.invitesEmptyDesc")}
        />
      }
    />
  );
}

// ===========================================================================
// CREATE INVITE DIALOG
// ===========================================================================

const inviteFormSchema = z.object({
  role: z.enum(["dispatcher", "driver"]),
  email: z.string().email(tr("admin.users.invalidEmail")).optional().or(z.literal("")),
  ttlHours: z.coerce.number().int().min(1).max(720),
  subscriptionDays: z.coerce.number().int().min(1).max(365),
  linkedClientId: z.string().optional().or(z.literal("")),
});
type InviteFormValues = z.infer<typeof inviteFormSchema>;

function CreateInviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [success, setSuccess] = useState<(Invite & { signupUrl?: string }) | null>(null);

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { role: "dispatcher", email: "", ttlHours: 72, subscriptionDays: 30, linkedClientId: "" },
  });

  const mutation = useMutation({
    mutationFn: async (values: InviteFormValues) => {
      const body: CreateInviteInput = {
        role: values.role,
        email: values.email || undefined,
        ttlHours: values.ttlHours,
        subscriptionDays: values.subscriptionDays,
        linkedClientId: values.linkedClientId || undefined,
      };
      return apiJson<Invite & { signupUrl?: string }>("POST", "/api/admin/invites", body);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/invites") });
      setSuccess(data);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("common.error"), description: err.message });
    },
  });

  function handleClose() {
    onOpenChange(false);
    setTimeout(() => {
      form.reset();
      setSuccess(null);
    }, 200);
  }

  return (
    <Dialog open={open} onOpenChange={(b) => (b ? onOpenChange(true) : handleClose())}>
      <DialogContent className="sm:max-w-md">
        {success ? (
          <InviteSuccessView invite={success} onClose={handleClose} />
        ) : (
          <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
            <DialogHeader>
              <DialogTitle>{t("admin.users.createInvite")}</DialogTitle>
              <DialogDescription>
                {t("admin.users.createInviteDesc")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="role">{t("admin.users.colRole")}</Label>
                <Select
                  value={form.watch("role")}
                  onValueChange={(v) => form.setValue("role", v as "dispatcher" | "driver")}
                >
                  <SelectTrigger id="role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dispatcher">{t("admin.users.roleDispatcher")}</SelectItem>
                    <SelectItem value="driver">{t("admin.users.roleDriver")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email">{t("admin.users.emailOptional")}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t("admin.users.emailPlaceholder")}
                  {...form.register("email")}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("admin.users.emailHint")}
                </p>
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive">{t("admin.users.emailInvalid")}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ttlHours">{t("admin.users.ttlLabel")}</Label>
                <Input
                  id="ttlHours"
                  type="number"
                  min={1}
                  max={720}
                  {...form.register("ttlHours")}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("admin.users.ttlHint")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="subscriptionDays">Подписка (дней)</Label>
                <Input
                  id="subscriptionDays"
                  type="number"
                  min={1}
                  max={365}
                  {...form.register("subscriptionDays")}
                />
                <p className="text-[11px] text-muted-foreground">
                  Сколько дней действует подписка у созданного аккаунта. По умолчанию 30.
                </p>
              </div>

              {form.watch("role") === "driver" && (
                <div className="space-y-1.5">
                  <Label>{t("admin.users.linkClientLabel")}</Label>
                  <ClientCombobox
                    value={form.watch("linkedClientId") || ""}
                    onChange={(v) => form.setValue("linkedClientId", v)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t("admin.users.linkClientHint")}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t("admin.users.creating") : t("admin.users.create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InviteSuccessView({
  invite,
  onClose,
}: {
  invite: Invite & { signupUrl?: string };
  onClose: () => void;
}) {
  const { t } = useT();
  const { copy, copied } = useClipboard();
  const { copy: copyUrl, copied: copiedUrl } = useClipboard();
  const url = invite.signupUrl || `${window.location.origin}/#/signup?code=${encodeURIComponent(invite.code)}`;

  return (
    <>
      <DialogHeader>
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <DialogTitle className="text-center">{t("admin.users.inviteCreated")}</DialogTitle>
        <DialogDescription className="text-center">
          {t("admin.users.inviteCreatedDesc", { date: formatDateFull(invite.expiresAt) })}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        <div>
          <Label className="text-xs">{t("admin.users.colCode")}</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <Input readOnly value={invite.code} className="font-mono tracking-wider" />
            <Button type="button" variant="outline" size="icon" onClick={() => copy(invite.code)}>
              {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div>
          <Label className="text-xs">{t("admin.users.signupLink")}</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <Input readOnly value={url} className="text-xs" />
            <Button type="button" variant="outline" size="icon" onClick={() => copyUrl(url)}>
              {copiedUrl ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <Alert>
          <AlertDescription className="text-xs">
            <strong>{t("admin.users.sendCodeOnce")}</strong> {t("admin.users.codeUnavailableAfter")}
          </AlertDescription>
        </Alert>
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const msg = `DispatchOS invite: ${url}`;
            window.open(`https://t.me/share/url?url=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
          }}
        >
          <Send className="h-4 w-4" />
          {t("admin.users.toTelegram")}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("common.success")}
        </Button>
      </DialogFooter>
    </>
  );
}

// ===========================================================================
// RESET PASSWORD DIALOG
// ===========================================================================

type ResetPasswordResponse = {
  temporaryPassword: string;
  userId: string;
  email: string;
};

function ResetPasswordDialog({ user, onClose }: { user: UserPublic; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useToast();
  const { copy, copied } = useClipboard();
  const [result, setResult] = useState<ResetPasswordResponse | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiJson<ResetPasswordResponse>("POST", `/api/admin/users/${user.id}/reset-password`, {}),
    onSuccess: (data) => setResult(data),
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("common.error"), description: err.message });
    },
  });

  return (
    <Dialog open onOpenChange={(b) => !b && onClose()}>
      <DialogContent className="sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
                <KeyRound className="h-6 w-6" />
              </div>
              <DialogTitle className="text-center">{t("admin.users.passwordReset")}</DialogTitle>
              <DialogDescription className="text-center">
                {t("admin.users.passwordResetDesc")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div>
                <Label className="text-xs">{t("admin.users.tempPasswordFor", { email: result.email })}</Label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input readOnly value={result.temporaryPassword} className="font-mono" />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => copy(result.temporaryPassword)}
                  >
                    {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  {t("admin.users.tempPasswordWarning")}
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t("admin.users.passwordHandedOff")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("admin.users.resetPasswordConfirm")}</DialogTitle>
              <DialogDescription>
                {t("admin.users.resetPasswordConfirmDesc1")} <strong>{user.fullName}</strong> ({user.email}) {t("admin.users.resetPasswordConfirmDesc2")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                {mutation.isPending ? t("admin.users.resetting") : t("admin.users.reset")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// RESET TOTP DIALOG
// ===========================================================================

type ResetTotpResponse =
  | { userId: string; totpSecret: string; otpauthUrl: string }
  | { userId: string; totpDisabled: true };

export function ResetTotpDialog({ user, onClose, initialMode }: { user: UserPublic; onClose: () => void; initialMode?: "reset" | "disable" }) {
  const { t } = useT();
  const { toast } = useToast();
  const { copy, copied } = useClipboard();
  const qc = useQueryClient();
  const [result, setResult] = useState<ResetTotpResponse | null>(null);
  const [mode, setMode] = useState<"reset" | "disable">(initialMode ?? "reset");

  const mutation = useMutation({
    mutationFn: () =>
      apiJson<ResetTotpResponse>("POST", `/api/admin/users/${user.id}/reset-totp`, {
        disable: mode === "disable",
      }),
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/admin/users") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("common.error"), description: err.message });
    },
  });

  return (
    <Dialog open onOpenChange={(b) => !b && onClose()}>
      <DialogContent className="sm:max-w-md">
        {result ? (
          "totpDisabled" in result ? (
            <>
              <DialogHeader>
                <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
                  <ShieldOff className="h-6 w-6" />
                </div>
                <DialogTitle className="text-center">{t("admin.users.twoFaDisabled")}</DialogTitle>
                <DialogDescription className="text-center">
                  {t("admin.users.twoFaDisabledDesc", { name: user.fullName })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={onClose}>{t("common.success")}</Button>
              </DialogFooter>
            </>
          ) : (
            <ResetTotpQRView result={result} user={user} onClose={onClose} copy={copy} copied={copied} />
          )
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("admin.users.reset2fa")}</DialogTitle>
              <DialogDescription>
                {t("admin.users.reset2faDesc", { name: user.fullName })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-4">
              <button
                type="button"
                onClick={() => setMode("reset")}
                className={cn_button(mode === "reset")}
              >
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
                  <div>
                    <p className="text-sm font-medium">{t("admin.users.reissue")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("admin.users.reissueDesc")}
                    </p>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setMode("disable")}
                className={cn_button(mode === "disable")}
              >
                <div className="flex items-start gap-3">
                  <ShieldOff className="mt-0.5 h-5 w-5 text-warning" />
                  <div>
                    <p className="text-sm font-medium">{t("admin.users.disable2fa")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("admin.users.disable2faDesc")}
                    </p>
                  </div>
                </div>
              </button>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                {mutation.isPending ? t("admin.users.resetting") : mode === "reset" ? t("admin.users.reissue") : t("admin.users.disableAction")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function cn_button(active: boolean) {
  return [
    "w-full rounded-lg border p-3 text-left transition-all",
    active
      ? "border-primary bg-primary/5 shadow-sm"
      : "border-border bg-card hover:border-primary/30 hover:bg-muted/40",
  ].join(" ");
}

function ResetTotpQRView({
  result,
  user,
  onClose,
  copy,
  copied,
}: {
  result: { userId: string; totpSecret: string; otpauthUrl: string };
  user: UserPublic;
  onClose: () => void;
  copy: (s: string) => Promise<boolean>;
  copied: boolean;
}) {
  const { t } = useT();


  return (
    <>
      <DialogHeader>
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <DialogTitle className="text-center">{t("admin.users.new2faFor", { name: user.fullName })}</DialogTitle>
        <DialogDescription className="text-center">
          {t("admin.users.new2faDesc")}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-4">
        <div className="flex justify-center rounded-md border border-border bg-card p-3">
          <QRCodeSVG value={result.otpauthUrl} size={176} level="M" aria-label="TOTP QR" />
        </div>
        <div>
          <Label className="text-xs">{t("admin.users.secretManual")}</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <Input readOnly value={result.totpSecret} className="font-mono text-xs" />
            <Button type="button" variant="outline" size="icon" onClick={() => copy(result.totpSecret)}>
              {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs">
            {t("admin.users.secretShownOnce")}
          </AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button onClick={onClose}>{t("admin.users.secretHandedOff")}</Button>
      </DialogFooter>
    </>
  );
}
// ===========================================================================
// ClientCombobox — searchable client picker for invite form
// ===========================================================================
function ClientCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: () => apiJson<Client[]>("GET", "/api/clients"),
    staleTime: 60_000,
  });

  const selected = clients.find((c) => c.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="flex flex-col items-start text-left">
              <span className="text-sm">{selected.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {selected.mc} · {selected.id}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {isLoading ? t("common.loading") : t("admin.users.selectClient")}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("admin.users.clientSearchPlaceholder")} />
          <CommandEmpty>{t("admin.users.clientsNotFound")}</CommandEmpty>
          <CommandGroup className="max-h-64 overflow-auto">
            {value && (
              <CommandItem
                value="__clear__"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="text-muted-foreground"
              >
                {t("admin.users.clearSelection")}
              </CommandItem>
            )}
            {clients.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.name} ${c.mc} ${c.id}`}
                onSelect={() => {
                  onChange(c.id);
                  setOpen(false);
                }}
              >
                <Check
                  className={`mr-2 h-4 w-4 ${
                    value === c.id ? "opacity-100" : "opacity-0"
                  }`}
                />
                <div className="flex flex-col">
                  <span className="text-sm">{c.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {c.mc} · {c.id}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
