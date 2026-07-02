import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronsUpDown,
  Loader2,
  Save,
  ShieldOff,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Client, UserPublic, UserRole } from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useT } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import { RoleBadge } from "@/components/dispatch/RoleBadge";
import { formatDateFull } from "@/lib/format";
import { formatUsPhone, toE164Us, fromE164Us } from "@/lib/format-phone";
import { cn } from "@/lib/utils";
import { ResetTotpDialog } from "@/pages/admin/users";
import { DriverLocationCard } from "@/components/tracking/DriverLocationCard";

/**
 * Admin / User detail — /admin/users/:id
 *
 * Edit fullName, role, linkedClientId (drivers only), phone, blocked.
 * Soft-delete via the danger zone (DELETE -> stamps deletedAt + blocks).
 *
 * Backend: GET/PATCH/DELETE /api/admin/users/:id (server/routes/admin.ts)
 */

const ROLE_OPTIONS: { value: UserRole; labelKey: string }[] = [
  { value: "admin", labelKey: "admin.userDetail.roleAdmin" },
  { value: "dispatcher", labelKey: "admin.userDetail.roleDispatcher" },
  { value: "driver", labelKey: "admin.userDetail.roleDriver" },
];

type FormState = {
  fullName: string;
  email: string;
  role: UserRole;
  linkedClientId: string;
  phone: string;
  // Henry QA Bug #5 — truck unit number (shown/editable for drivers only).
  unitNumber: string;
  /**
   * UI-only field for drivers. When false (owner-operator), we send
   * linkedClientId=null to the backend regardless of the combobox value.
   * When true (employee), we send the selected client.
   */
  driverIsEmployee: boolean;
};

export default function UserDetailPage() {
  const { t } = useT();
  const [match, params] = useRoute("/users/:id");
  const [, setLocation] = useLocation();
  const userId = match ? params?.id : null;
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<UserPublic>({
    queryKey: ["/api/admin/users", userId],
    queryFn: () => apiJson<UserPublic>("GET", `/api/admin/users/${userId}`),
    enabled: Boolean(userId),
  });

  const [form, setForm] = useState<FormState>({
    fullName: "",
    email: "",
    role: "driver",
    linkedClientId: "",
    phone: "",
    unitNumber: "",
    driverIsEmployee: true,
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetTotpMode, setResetTotpMode] = useState<"rotate" | "disable" | null>(null);

  // Hydrate the form once data arrives (or when the user id changes).
  useEffect(() => {
    if (data) {
      setForm({
        fullName: data.fullName ?? "",
        email: data.email,
        role: data.role,
        linkedClientId: data.linkedClientId ?? "",
        // Convert stored E.164 (+11234567890) to display format ("(123) 456-7890").
        // Falls back to empty string for non-US / legacy freeform phone values.
        phone: fromE164Us(data.phone) || (data.phone && !data.phone.startsWith("+1") ? data.phone : ""),
        unitNumber: (data as any).unitNumber ?? "",
        // For drivers: employee if a linkedClientId is set, otherwise owner-op.
        driverIsEmployee: Boolean(data.linkedClientId),
      });
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      // Convert display format "(123) 456-7890" → E.164 "+11234567890" for storage.
      // toE164Us returns null for incomplete/empty inputs — we send null to clear the field.
      const phoneE164 = form.phone ? (toE164Us(form.phone) ?? form.phone) : null;
      const body: Record<string, unknown> = {
        fullName: form.fullName,
        role: form.role,
        phone: phoneE164,
        // Henry QA Bug #5 — only send unitNumber for drivers; send null to clear.
        unitNumber: form.role === "driver" ? (form.unitNumber.trim() || null) : undefined,
      };
      // Only send email if it actually changed — saves an audit event and
      // avoids the uniqueness check round-trip for no-op saves.
      if (data && form.email.trim().toLowerCase() !== data.email.toLowerCase()) {
        body.email = form.email.trim();
      }
      // linkedClientId is only meaningful for drivers employed by a company.
      // Owner-operators and non-drivers always get null.
      if (form.role === "driver" && form.driverIsEmployee) {
        body.linkedClientId = form.linkedClientId || null;
      } else {
        body.linkedClientId = null;
      }
      return apiJson<UserPublic>("PATCH", `/api/admin/users/${userId}`, body);
    },
    onSuccess: () => {
      toast({ title: t("admin.userDetail.saved"), description: t("admin.userDetail.savedDesc") });
      qc.invalidateQueries({ queryKey: ["/api/admin/users"], exact: false });
    },
    onError: (err: Error) => {
      toast({ title: t("admin.userDetail.saveFailed"), description: err.message, variant: "destructive" });
    },
  });

  const blockMutation = useMutation({
    mutationFn: (blocked: boolean) =>
      apiJson<UserPublic>("PATCH", `/api/admin/users/${userId}`, { blocked }),
    onSuccess: (updated) => {
      toast({
        title: updated.blocked ? t("admin.userDetail.blocked") : t("admin.userDetail.unblocked"),
      });
      qc.invalidateQueries({ queryKey: ["/api/admin/users"], exact: false });
    },
    onError: (err: Error) => {
      toast({ title: t("admin.userDetail.actionFailed"), description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiJson("DELETE", `/api/admin/users/${userId}`),
    onSuccess: () => {
      toast({ title: t("admin.userDetail.userDeleted") });
      qc.invalidateQueries({ queryKey: ["/api/admin/users"], exact: false });
      setLocation("/users");
    },
    onError: (err: Error) => {
      toast({ title: t("admin.userDetail.deleteFailed"), description: err.message, variant: "destructive" });
      setDeleteOpen(false);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/users")} />
        <Card className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }

  if (error || !data) {
    const is404 = error instanceof ApiError && error.status === 404;
    return (
      <div className="space-y-4">
        <BackBar onClick={() => setLocation("/users")} />
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">
            {is404 ? t("admin.userDetail.notFound") : t("admin.userDetail.loadFailed")}
          </p>
        </Card>
      </div>
    );
  }

  const isDeleted = Boolean(data.deletedAt);

  return (
    <div className="space-y-4 pb-24">
      <BackBar onClick={() => setLocation("/users")} />

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold tracking-tight">
            {data.fullName || data.email}
          </p>
          <p className="truncate text-sm text-muted-foreground">{data.email}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RoleBadge role={data.role} />
          {data.blocked && !isDeleted && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600">
              {t("admin.userDetail.blocked")}
            </Badge>
          )}
          {isDeleted && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              {t("admin.userDetail.deleted")}
            </Badge>
          )}
        </div>
      </div>

      {isDeleted && (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">{t("admin.userDetail.deletedBannerTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.userDetail.deletedBannerDesc", { date: formatDateFull(data.deletedAt!) })}
          </p>
        </Card>
      )}

      {/* Profile card */}
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.userDetail.profile")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fullName">{t("admin.userDetail.name")}</Label>
            <Input
              id="fullName"
              value={form.fullName}
              disabled={isDeleted}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">{t("common.email")}</Label>
            <Input
              id="email"
              type="email"
              value={form.email}
              disabled={isDeleted}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("admin.userDetail.emailHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{t("admin.userDetail.role")}</Label>
            <Select
              value={form.role}
              disabled={isDeleted}
              onValueChange={(v) => setForm((f) => ({ ...f, role: v as UserRole }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {t(r.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.role === "driver" && (
            <div className="space-y-2">
              <Label>{t("admin.userDetail.employmentType")}</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isDeleted}
                  onClick={() => setForm((f) => ({ ...f, driverIsEmployee: true }))}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-sm transition",
                    form.driverIsEmployee
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  <div className="font-medium">{t("admin.userDetail.employeeTitle")}</div>
                  <div className="mt-0.5 text-[11px] opacity-80">{t("admin.userDetail.employeeDesc")}</div>
                </button>
                <button
                  type="button"
                  disabled={isDeleted}
                  onClick={() => setForm((f) => ({ ...f, driverIsEmployee: false, linkedClientId: "" }))}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-sm transition",
                    !form.driverIsEmployee
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  <div className="font-medium">{t("admin.userDetail.ownerOperatorTitle")}</div>
                  <div className="mt-0.5 text-[11px] opacity-80">{t("admin.userDetail.ownerOperatorDesc")}</div>
                </button>
              </div>
              {form.driverIsEmployee && (
                <div className="space-y-1.5 pt-1">
                  <Label>{t("admin.userDetail.clientCarrier")}</Label>
                  <ClientCombobox
                    value={form.linkedClientId}
                    disabled={isDeleted}
                    onChange={(v) => setForm((f) => ({ ...f, linkedClientId: v }))}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t("admin.userDetail.clientCarrierHint")}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="phone">{t("admin.userDetail.phoneUs")}</Label>
            <Input
              id="phone"
              value={form.phone}
              disabled={isDeleted}
              placeholder="(555) 123-4567"
              maxLength={14}
              onChange={(e) => {
                // Apply US phone mask on every keystroke.
                // The raw value is kept as display format; E.164 conversion
                // happens in the save handler (toE164Us).
                setForm((f) => ({ ...f, phone: formatUsPhone(e.target.value) }));
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("admin.userDetail.phoneHint")}
            </p>
          </div>

          {/* Henry QA Bug #5 — truck unit number, drivers only */}
          {form.role === "driver" && (
            <div className="space-y-1.5">
              <Label htmlFor="unitNumber">{t("admin.userDetail.truckUnit")}</Label>
              <Input
                id="unitNumber"
                value={form.unitNumber}
                disabled={isDeleted}
                placeholder={t("admin.userDetail.truckUnitPlaceholder")}
                maxLength={50}
                onChange={(e) => setForm((f) => ({ ...f, unitNumber: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("admin.userDetail.truckUnitHint")}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">
                {data.blocked ? t("admin.userDetail.blocked") : t("admin.userDetail.active")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("admin.userDetail.blockHint")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isDeleted || blockMutation.isPending}
              onClick={() => blockMutation.mutate(!data.blocked)}
            >
              {data.blocked ? (
                <>
                  <ShieldCheck className="h-4 w-4" /> {t("admin.userDetail.unblock")}
                </>
              ) : (
                <>
                  <ShieldOff className="h-4 w-4" /> {t("admin.userDetail.block")}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Driver location card (GPS tracking via Traccar/Owntracks) */}
      {!isDeleted && data.role === "driver" && (
        <DriverLocationCard userId={data.id} userName={data.fullName || data.email} />
      )}

      {/* Security card — 2FA reset / disable */}
      {!isDeleted && (
        <Card>
          <CardHeader>
            <CardTitle>{t("admin.userDetail.security")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{t("admin.userDetail.twoFactor")}</p>
                <p className="text-xs text-muted-foreground">
                  {data.twoFactorEnabled
                    ? t("admin.userDetail.twoFactorOn")
                    : t("admin.userDetail.twoFactorOff")}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setResetTotpMode("rotate")}
                >
                  <ShieldCheck className="h-4 w-4" /> {t("admin.userDetail.newQr")}
                </Button>
                {data.twoFactorEnabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetTotpMode("disable")}
                  >
                    <ShieldOff className="h-4 w-4" /> {t("admin.userDetail.disable")}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("admin.userDetail.twoFactorActionsHint")}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Danger zone */}
      {!isDeleted && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">{t("admin.userDetail.dangerZone")}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {t("admin.userDetail.deleteWarning")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" /> {t("admin.userDetail.delete")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Sticky save */}
      {!isDeleted && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 p-3 backdrop-blur sm:left-64">
          <div className="mx-auto flex max-w-3xl justify-end">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {/* TOTP reset / disable dialog (shared with users list) */}
      {resetTotpMode && data && (
        <ResetTotpDialog
          user={data}
          initialMode={resetTotpMode === "rotate" ? "reset" : "disable"}
          onClose={() => {
            setResetTotpMode(null);
            qc.invalidateQueries({ queryKey: ["/api/admin/users", userId] });
          }}
        />
      )}

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t("admin.userDetail.deleteConfirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("admin.userDetail.deleteConfirmDesc", { name: data.fullName || data.email })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="border-destructive/40 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t("admin.userDetail.deleteForever")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BackBar({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      {t("admin.userDetail.backToUsers")}
    </button>
  );
}

function ClientCombobox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
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
          disabled={disabled}
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
              {isLoading ? t("common.loading") : t("admin.userDetail.selectClient")}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("admin.userDetail.clientSearchPlaceholder")} />
          <CommandEmpty>{t("admin.userDetail.noClients")}</CommandEmpty>
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
                {t("admin.userDetail.clearSelection")}
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
                  className={`mr-2 h-4 w-4 ${value === c.id ? "opacity-100" : "opacity-0"}`}
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
