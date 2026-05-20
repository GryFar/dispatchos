import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Inbox,
  MessageSquare,
  Plug,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiJson } from "@/lib/queryClient";

type IntegrationKind =
  | "feeder"
  | "enrichment"
  | "messaging"
  | "observability"
  | "infra";

type IntegrationStatus =
  | "ready"
  | "active"
  | "needs_config"
  | "local_endpoint_ready"
  | "local_folder_mode"
  | "sandbox"
  | "error";

interface Integration {
  key: string;
  label: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  missing: string[];
  stats24h: { eventCount: number; lastEventAt: string | null };
  notes?: string;
}

interface IntegrationsResponse {
  generatedAt: string;
  integrations: Integration[];
}

type KindMeta = { label: string; icon: typeof Plug };
const KIND_META: Record<IntegrationKind, KindMeta> = {
  feeder: { label: "Источник грузов", icon: Inbox },
  enrichment: { label: "Обогащение данных", icon: Sparkles },
  messaging: { label: "Коммуникации", icon: MessageSquare },
  observability: { label: "Мониторинг", icon: Activity },
  infra: { label: "Инфраструктура", icon: Database },
};

type ToneKey = "active" | "ok" | "warn" | "muted" | "danger";
type StatusMeta = { label: string; tone: ToneKey };
const STATUS_META: Record<IntegrationStatus, StatusMeta> = {
  active: { label: "Активен", tone: "active" },
  ready: { label: "Готов", tone: "ok" },
  needs_config: { label: "Не настроен", tone: "warn" },
  local_endpoint_ready: { label: "Локально", tone: "muted" },
  local_folder_mode: { label: "Локально", tone: "muted" },
  sandbox: { label: "Sandbox", tone: "muted" },
  error: { label: "Ошибка", tone: "danger" },
};

const TONE_CLASS: Record<ToneKey, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  ok: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  muted: "bg-muted text-muted-foreground border-border",
  danger: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}с назад`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}м назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}ч назад`;
  const days = Math.round(hours / 24);
  return `${days}д назад`;
}

export default function IntegrationsPage() {
  const { data, isLoading, isError } = useQuery<IntegrationsResponse>({
    queryKey: ["/api/admin/integrations"],
    queryFn: () => apiJson("GET", "/api/admin/integrations"),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Admin / Платформа
        </p>
        <h1 className="text-2xl font-semibold">Интеграции</h1>
        <p className="text-sm text-muted-foreground">
          Статус всех внешних сервисов и счётчики активности за последние 24 часа.
          Чтобы добавить новый коннектор — отредактируй{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            server/lib/integrations.ts
          </code>
          .
        </p>
      </header>

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-border bg-muted/40"
            />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-rose-500">
            <AlertTriangle className="h-4 w-4" />
            Не удалось загрузить статус интеграций.
          </CardContent>
        </Card>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.integrations.map((item) => (
            <IntegrationCard key={item.key} item={item} />
          ))}
        </div>
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          Обновлено: {new Date(data.generatedAt).toLocaleString("ru-RU")}
        </p>
      )}
    </div>
  );
}

function IntegrationCard({ item }: { item: Integration }) {
  const kindMeta = KIND_META[item.kind];
  const statusMeta = STATUS_META[item.status];
  const KindIcon = kindMeta.icon;

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <div className="rounded-md bg-muted p-2">
              <KindIcon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base leading-tight">
                {item.label}
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {kindMeta.label}
              </p>
            </div>
          </div>
          <Badge
            variant="outline"
            className={TONE_CLASS[statusMeta.tone]}
          >
            {statusMeta.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Activity className="h-3 w-3" />
            {item.stats24h.eventCount} событий / 24ч
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelative(item.stats24h.lastEventAt)}
          </span>
        </div>

        {item.missing.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
            <p className="mb-1 inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
              <Wrench className="h-3 w-3" />
              Не сконфигурировано
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {item.missing.join(", ")}
            </p>
          </div>
        )}

        {item.status === "active" && item.missing.length === 0 && (
          <div className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            Работает
          </div>
        )}

        {item.notes && (
          <p className="text-xs text-muted-foreground">{item.notes}</p>
        )}
      </CardContent>
    </Card>
  );
}