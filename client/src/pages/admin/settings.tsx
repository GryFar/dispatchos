import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Lock,
  Plug,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { useAuth } from "@/lib/use-auth";
import { formatDateFull, formatRelativeAgo } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Two-Factor Authentication (TOTP)
              </p>
              <p className="mt-1 text-sm">
                {user.twoFactorEnabled ? (
                  <span className="inline-flex items-center gap-1.5 text-success">
                    <CheckCircle2 className="h-4 w-4" /> Включено
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-warning">
                    <AlertCircle className="h-4 w-4" /> Не включено
                  </span>
                )}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Перевыпуск TOTP self-service появится в Phase 3 (endpoint /api/me/totp).
                Сейчас — через другого admin'а в разделе Пользователи.
              </p>
            </div>
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
