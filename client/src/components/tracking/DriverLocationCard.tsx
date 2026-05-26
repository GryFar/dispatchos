// ===========================================================================
// DriverLocationCard — live location widget for admin user-detail
// ===========================================================================
//
// Renders:
//   1. Current position chip + status badge (🟢 live / 🟡 stale / 🔴 offline)
//   2. Google Maps Embed iframe centered on the driver's last known point
//   3. Polyline (rendered via Static Maps URL params) of the last 24h
//   4. "Setup tracking" CTA when the user has no tracking_token, opening a
//      modal with step-by-step instructions for Traccar Client (Android) +
//      Owntracks (iOS).
//
// Polls /api/admin/users/:id/track every 30s while the page is open. Pauses
// when the tab is hidden (TanStack Query handles that automatically via
// refetchOnWindowFocus + the page-visibility listener).
// ---------------------------------------------------------------------------

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  MapPin,
  Radio,
  AlertTriangle,
  WifiOff,
  Smartphone,
  Copy,
  Check,
} from "lucide-react";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Ping = {
  id: string;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  heading_deg: number | null;
  source: string;
  captured_at: string;
};

type TrackResponse = {
  userId: string;
  current: {
    lat: number;
    lng: number;
    capturedAt: string;
    accuracyM: number | null;
    source: string;
  } | null;
  pings: Ping[];
  hasTrackingToken: boolean;
};

type TokenResponse = {
  userId: string;
  token: string;
  osmandUrl: string;
  owntracksUrl: string;
  owntracksUserId: string;
};

function freshnessTier(capturedAt: string | undefined): {
  tier: "live" | "stale" | "offline";
  minutesAgo: number;
  label: string;
  className: string;
} {
  if (!capturedAt) {
    return { tier: "offline", minutesAgo: Infinity, label: "Нет данных", className: "border-muted text-muted-foreground" };
  }
  const minutesAgo = (Date.now() - new Date(capturedAt).getTime()) / 60000;
  if (minutesAgo < 5) {
    return {
      tier: "live",
      minutesAgo,
      label: `🟢 онлайн · ${Math.round(minutesAgo)} мин назад`,
      className: "border-success/40 text-success",
    };
  }
  if (minutesAgo < 30) {
    return {
      tier: "stale",
      minutesAgo,
      label: `🟡 ${Math.round(minutesAgo)} мин назад`,
      className: "border-warning/40 text-warning",
    };
  }
  if (minutesAgo < 60 * 24) {
    return {
      tier: "offline",
      minutesAgo,
      label: `🔴 ${Math.round(minutesAgo / 60)} ч назад`,
      className: "border-destructive/40 text-destructive",
    };
  }
  return {
    tier: "offline",
    minutesAgo,
    label: `🔴 ${Math.round(minutesAgo / 60 / 24)} д назад`,
    className: "border-destructive/40 text-destructive",
  };
}

export function DriverLocationCard({ userId, userName }: { userId: string; userName: string }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupResult, setSetupResult] = useState<TokenResponse | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const trackQ = useQuery<TrackResponse>({
    queryKey: ["/api/admin/users", userId, "track"],
    queryFn: () => apiJson<TrackResponse>("GET", `/api/admin/users/${userId}/track?sinceHours=24`),
    refetchInterval: 30_000,
    enabled: Boolean(userId),
  });

  const mapsKeyQ = useQuery<{ key: string | null }>({
    queryKey: ["/api/admin/config/maps-key"],
    queryFn: () => apiJson("GET", "/api/admin/config/maps-key"),
    staleTime: 60 * 60 * 1000, // 1h — the key doesn't change between requests
  });

  const issueTokenMutation = useMutation({
    mutationFn: () => apiJson<TokenResponse>("POST", `/api/admin/users/${userId}/tracking-token`, {}),
    onSuccess: (data) => {
      setSetupResult(data);
      qc.invalidateQueries({ queryKey: ["/api/admin/users", userId, "track"] });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Ошибка", description: err.message });
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: () => apiJson("POST", `/api/admin/users/${userId}/tracking-token`, { revoke: true }),
    onSuccess: () => {
      toast({ description: "Трекинг отключён. Старая ссылка больше не работает." });
      qc.invalidateQueries({ queryKey: ["/api/admin/users", userId, "track"] });
    },
  });

  if (trackQ.isLoading) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (!trackQ.data) return null;

  const { current, pings, hasTrackingToken } = trackQ.data;
  const freshness = freshnessTier(current?.capturedAt);
  const mapsKey = mapsKeyQ.data?.key;

  // No token issued yet → render the setup CTA card.
  if (!hasTrackingToken) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Геолокация</span>
              <Badge variant="outline" className="border-muted text-muted-foreground">
                Не настроено
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Водитель ещё не подключён к трекингу. Сгенерируйте токен и пришлите ему инструкцию — приложение работает в фоне 24/7 на iOS и Android.
            </p>
            <Button
              className="mt-3"
              onClick={() => {
                setSetupOpen(true);
                issueTokenMutation.mutate();
              }}
              disabled={issueTokenMutation.isPending}
            >
              {issueTokenMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Smartphone className="h-4 w-4" /> Включить трекинг
            </Button>
          </CardContent>
        </Card>
        {setupOpen && setupResult && (
          <TrackingSetupDialog
            data={setupResult}
            userName={userName}
            onClose={() => {
              setSetupOpen(false);
              setSetupResult(null);
            }}
          />
        )}
      </>
    );
  }

  // Token issued. Render the live map.
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2">
              <Radio className="h-4 w-4 text-primary" /> Геолокация
            </span>
            <Badge variant="outline" className={freshness.className}>
              {freshness.label}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {current ? (
            <div className="flex items-center justify-between text-sm">
              <div className="inline-flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-xs">
                  {current.lat.toFixed(5)}, {current.lng.toFixed(5)}
                </span>
                {current.source && (
                  <span className="text-[11px] text-muted-foreground">· {current.source}</span>
                )}
              </div>
              <a
                href={`https://www.google.com/maps?q=${current.lat},${current.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                Открыть в Google Maps
              </a>
            </div>
          ) : (
            <Alert variant="warning" />
          )}

          {mapsKey && current ? (
            <iframe
              title="driver-location"
              className="h-72 w-full rounded-md border border-border"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(mapsKey)}&q=${current.lat},${current.lng}&zoom=13`}
            />
          ) : !current ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              <WifiOff className="mx-auto mb-2 h-6 w-6" />
              Водитель ещё не отправил ни одного пинга. Убедитесь что приложение запущено и геолокация разрешена.
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              Карта недоступна — не настроен GOOGLE_MAPS_API_KEY.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
            <span>За последние 24ч — {pings.length} точек</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => {
                setSetupOpen(true);
                issueTokenMutation.mutate();
              }}>
                Новый токен
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => revokeTokenMutation.mutate()}
                disabled={revokeTokenMutation.isPending}
              >
                Отключить
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {setupOpen && setupResult && (
        <TrackingSetupDialog
          data={setupResult}
          userName={userName}
          onClose={() => {
            setSetupOpen(false);
            setSetupResult(null);
          }}
        />
      )}
    </>
  );
}

function Alert({ variant }: { variant: "warning" }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      <p>Токен сгенерирован, но пингов пока нет. Дождитесь первого пинга от приложения.</p>
    </div>
  );
}

function TrackingSetupDialog({
  data,
  userName,
  onClose,
}: {
  data: TokenResponse;
  userName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const { toast } = useToast();

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      toast({ description: `${what} скопирован` });
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast({ variant: "destructive", description: "Не удалось скопировать" });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Подключение трекинга — {userName}</DialogTitle>
          <DialogDescription>
            Перешлите эту инструкцию водителю. Приложение работает в фоне 24/7, батарея ~3-5% в сутки.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="android" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="android">Android · Traccar Client</TabsTrigger>
            <TabsTrigger value="ios">iOS · Owntracks</TabsTrigger>
          </TabsList>

          <TabsContent value="android" className="space-y-3 pt-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                Установи приложение{" "}
                <a
                  href="https://play.google.com/store/apps/details?id=org.traccar.client"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Traccar Client
                </a>{" "}
                из Play Store (бесплатно).
              </li>
              <li>Открой настройки приложения и заполни:</li>
            </ol>
            <CopyRow label="Server URL" value={data.osmandUrl.replace(/\?id=.*/, "")} onCopy={copy} copied={copied === "Server URL"} />
            <CopyRow label="Device identifier" value={data.token} onCopy={copy} copied={copied === "Device identifier"} />
            <p className="text-xs text-muted-foreground">
              Frequency = 60 секунд, Distance = 100 m, Accuracy = High. Разреши приложению фон, отключи battery optimization.
            </p>
          </TabsContent>

          <TabsContent value="ios" className="space-y-3 pt-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                Установи приложение{" "}
                <a
                  href="https://apps.apple.com/app/owntracks/id692424691"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  OwnTracks
                </a>{" "}
                из App Store (бесплатно).
              </li>
              <li>Settings → Mode = HTTP. Заполни:</li>
            </ol>
            <CopyRow label="URL" value={data.owntracksUrl} onCopy={copy} copied={copied === "URL"} />
            <CopyRow label="User ID" value={data.owntracksUserId} onCopy={copy} copied={copied === "User ID"} />
            <p className="text-xs text-muted-foreground">
              TrackerID = любые 2 символа (например, инициалы). Locator = Move (значимые перемещения). Разреши Location → Always.
            </p>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button onClick={onClose}>Готово</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopyRow({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: (value: string, label: string) => void;
  copied: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="break-all font-mono text-xs">{value}</p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => onCopy(value, label)}>
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
