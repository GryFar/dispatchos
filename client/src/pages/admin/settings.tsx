import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Lock,
  Plug,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useAuth } from "@/lib/use-auth";
import { useToast } from "@/hooks/use-toast";
import { formatDateFull, formatRelativeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RoleBadge } from "@/components/dispatch/RoleBadge";
import { cn } from "@/lib/utils";

/**
 * Settings — две вкладки: Интеграции (read-only) и Безопасность.
 *
 * Live endpoints:
 *   GET /api/integrations/status
 *   GET /api/me — для отображения текущего пользователя
 *
 * Изменение пароля и rotate TOTP — Phase 3 (/api/me/* endpoints для self-service).
 * Пока показываем read-only.
 */
export default function SettingsPage() {
  const [tab, setTab] = useState<"integrations" | "security">("integrations");

  return (
    <div className="space-y-6">
      <header className="border-b border-border pb-5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Admin / Настройки
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Интеграции, безопасность, профиль текущего пользователя.
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="integrations">
            <Plug className="mr-2 h-3.5 w-3.5" /> Интеграции
          </TabsTrigger>
          <TabsTrigger value="security">
            <Lock className="mr-2 h-3.5 w-3.5" /> Безопасность
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "integrations" ? <IntegrationsTab /> : <SecurityTab />}
    </div>
  );
}

// ===========================================================================
// INTEGRATIONS
// ===========================================================================

type IntegrationStatus = "ok" | "warn" | "missing" | "error" | string;

type IntegrationsResponse = {
  [key: string]:
    | {
        status?: IntegrationStatus;
        lastCheckedAt?: string;
        message?: string;
        configured?: boolean;
      }
    | undefined;
};

const INTEGRATION_LABELS: Record<string, { label: string; help: string }> = {
  fmcsa: { label: "FMCSA Safer", help: "Проверка authority и риск-скора брокеров" },
  telegram: { label: "Telegram", help: "Бот для команд водителей (/loc, /yes, /no)" },
  gmail: { label: "Gmail", help: "Ingest rate confirmations из email" },
  drive: { label: "Google Drive", help: "Архив документов клиентов" },
  google_drive: { label: "Google Drive", help: "Архив документов клиентов" },
};

function IntegrationsTab() {
  const { data, isLoading, error } = useQuery<IntegrationsResponse>({
    queryKey: ["/api/integrations/status"],
    queryFn: () => apiJson<IntegrationsResponse>("GET", "/api/integrations/status"),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-skeleton rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Не удалось загрузить интеграции: {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  const entries = Object.entries(data ?? {}).filter(([, v]) => v != null);

  return (
    <div className="space-y-3">
      {entries.length === 0 ? (
        <Alert>
          <AlertDescription>Интеграции не настроены.</AlertDescription>
        </Alert>
      ) : (
        entries.map(([key, h]) => {
          const meta = INTEGRATION_LABELS[key] ?? { label: key, help: "" };
          const status = (h?.status ?? (h?.configured ? "ok" : "missing")) as IntegrationStatus;
          return (
            <Card key={key} className="card-hover shadow-card">
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <IntegrationIcon status={status} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{meta.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {h?.message ?? meta.help}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {h?.lastCheckedAt && (
                    <span
                      className="hidden text-[10px] text-muted-foreground sm:inline"
                      title={formatDateFull(h.lastCheckedAt)}
                    >
                      {formatRelativeAgo(h.lastCheckedAt)}
                    </span>
                  )}
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                      status === "ok" && "bg-success/10 text-success",
                      status === "warn" && "bg-warning/10 text-warning",
                      status === "missing" && "bg-muted text-muted-foreground",
                      status === "error" && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {status === "ok" ? "OK"
                      : status === "warn" ? "Warn"
                      : status === "missing" ? "Не настроено"
                      : status === "error" ? "Ошибка"
                      : status}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
      <p className="text-[11px] text-muted-foreground">
        Изменение настроек интеграций — через переменные окружения <span className="font-mono">.env</span>{" "}
        и рестарт сервера.
      </p>
    </div>
  );
}

function IntegrationIcon({ status }: { status: IntegrationStatus }) {
  if (status === "ok") return <CheckCircle2 className="h-5 w-5 text-success" />;
  if (status === "warn") return <AlertCircle className="h-5 w-5 text-warning" />;
  if (status === "error") return <XCircle className="h-5 w-5 text-destructive" />;
  return <CircleDashed className="h-5 w-5 text-muted-foreground" />;
}

// ===========================================================================
// SECURITY
// ===========================================================================

function SecurityTab() {
  const { user } = useAuth();

  if (!user) {
    return (
      <Alert>
        <AlertDescription>Загрузка профиля...</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="card-hover shadow-card">
        <CardContent className="p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Профиль
          </h3>
          <dl className="space-y-3">
            <Row label="ФИО" value={user.fullName} />
            <Row label="Email" value={user.email} />
            <Row label="Роль" value={<RoleBadge role={user.role} />} />
            <Row
              label="Статус"
              value={
                <span className={user.blocked ? "text-destructive" : "text-success"}>
                  {user.blocked ? "Заблокирован" : "Активен"}
                </span>
              }
            />
            <Row
              label="Создан"
              value={
                <span title={formatDateFull(user.createdAt)}>
                  {formatRelativeAgo(user.createdAt)}
                </span>
              }
            />
            {user.lastLoginAt && (
              <Row
                label="Последний вход"
                value={
                  <span title={formatDateFull(user.lastLoginAt)}>
                    {formatRelativeAgo(user.lastLoginAt)}
                  </span>
                }
              />
            )}
          </dl>
        </CardContent>
      </Card>

      <Card className="card-hover shadow-card">
        <CardContent className="p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Lock className="h-4 w-4 text-primary" />
            Аутентификация
          </h3>
          <div className="space-y-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Пароль
              </p>
              <p className="mt-1 text-sm">Хранится в виде PBKDF2-хеша.</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Смена пароля self-service появится в Phase 3 (endpoint /api/me/password).
                Сейчас — попросите другого admin'а сбросить через раздел Пользователи.
              </p>
            </div>
            <TwoFactorSection enabled={user.twoFactorEnabled} />
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Сессия
              </p>
              <p className="mt-1 text-sm">
                <span className="font-mono">dispatchos.sid</span> · cookie · same-origin · httpOnly
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

// ===========================================================================
// 2FA section — self-service setup / rotate / disable
// ===========================================================================
//
// Three states (controlled by `enabled` + local dialog state):
//   1. enabled=false → banner «Не включено» + [Настроить]
//   2. enabled=true  → «Включено» + [Перевыпустить QR] [Отключить]
//   3. dialogOpen → QR + secret + input для подтверждения
//
// API:
//   POST /api/me/totp/setup   → { secret, otpauthUrl }   (stages secret in session)
//   POST /api/me/totp/confirm { token } → { enabled: true } (commits to users.totp_secret)
function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Two-Factor Authentication (TOTP)
      </p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="text-sm">
          {enabled ? (
            <span className="inline-flex items-center gap-1.5 text-success">
              <CheckCircle2 className="h-4 w-4" /> Включено
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-warning">
              <AlertCircle className="h-4 w-4" /> Не включено
            </span>
          )}
        </p>
        <Button size="sm" variant={enabled ? "outline" : "default"} onClick={() => setDialogOpen(true)}>
          {enabled ? "Перевыпустить QR" : "Настроить"}
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Нужно для ролей admin / dispatcher. При перевыпуске старый QR перестаёт работать только после ввода кода из нового.
      </p>
      {dialogOpen && (
        <TotpSetupDialog
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

function TotpSetupDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [stage, setStage] = useState<"loading" | "scan" | "done">("loading");
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [token, setToken] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Kick off setup immediately on open.
  const setupMutation = useMutation({
    mutationFn: () => apiJson<{ secret: string; otpauthUrl: string }>("POST", "/api/me/totp/setup", {}),
    onSuccess: (data) => {
      setSetupData(data);
      setStage("scan");
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        description: err instanceof ApiError ? err.message : "Не удалось запустить настройку.",
      });
      onClose();
    },
  });

  // Auto-start on mount.
  useEffect(() => {
    setupMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmMutation = useMutation({
    mutationFn: (code: string) =>
      apiJson<{ enabled: true }>("POST", "/api/me/totp/confirm", { token: code }),
    onSuccess: () => {
      setStage("done");
      qc.invalidateQueries({ queryKey: ["/api/me"] });
      toast({ description: "2FA включена. При следующем входе потребуется код." });
    },
    onError: (err) => {
      setConfirmError(err instanceof ApiError ? err.message : "Неверный код");
    },
  });

  function handleConfirm() {
    setConfirmError(null);
    const clean = token.replace(/\D+/g, "");
    if (clean.length !== 6) {
      setConfirmError("Код должен быть из 6 цифр");
      return;
    }
    confirmMutation.mutate(clean);
  }



  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Настройка 2FA</DialogTitle>
          <DialogDescription>
            Отсканируйте QR в Google Authenticator, 1Password или Authy, затем введите 6-значный код для подтверждения.
          </DialogDescription>
        </DialogHeader>

        {stage === "loading" && (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {stage === "scan" && setupData && (
          <div className="space-y-4">
            <div className="flex justify-center rounded-md bg-white p-3">
              <QRCodeSVG value={setupData.otpauthUrl} size={192} level="M" aria-label="TOTP QR" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Не сканируется? Введите secret вручную:
              </Label>
              <div className="mt-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {setupData.secret}
              </div>
            </div>
            <div>
              <Label htmlFor="totp-confirm">Код из приложения</Label>
              <Input
                id="totp-confirm"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                className="mt-1 font-mono tracking-widest text-center text-lg"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              {confirmError && (
                <p className="mt-1 text-xs text-destructive">{confirmError}</p>
              )}
            </div>
          </div>
        )}

        {stage === "done" && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>2FA включена и будет запрошена при следующем входе.</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          {stage === "scan" && (
            <>
              <Button variant="ghost" onClick={onClose} disabled={confirmMutation.isPending}>
                Отмена
              </Button>
              <Button onClick={handleConfirm} disabled={confirmMutation.isPending || token.length < 6}>
                {confirmMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Подтвердить
              </Button>
            </>
          )}
          {stage === "done" && (
            <Button onClick={onClose}>Готово</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
