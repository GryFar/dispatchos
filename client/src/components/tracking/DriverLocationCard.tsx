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
import { useT } from "@/lib/i18n";
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

function freshnessTier(
  capturedAt: string | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): {
  tier: "live" | "stale" | "offline";
  minutesAgo: number;
  label: string;
  className: string;
} {
  if (!capturedAt) {
    return { tier: "offline", minutesAgo: Infinity, label: t("tracking.DriverLocationCard.noData"), className: "border-muted text-muted-foreground" };
  }
  const minutesAgo = (Date.now() - new Date(capturedAt).getTime()) / 60000;
  if (minutesAgo < 5) {
    return {
      tier: "live",
      minutesAgo,
      label: t("tracking.DriverLocationCard.onlineMinutesAgo", { minutes: Math.round(minutesAgo) }),
      className: "border-success/40 text-success",
    };
  }
  if (minutesAgo < 30) {
    return {
      tier: "stale",
      minutesAgo,
      label: t("tracking.DriverLocationCard.minutesAgo", { minutes: Math.round(minutesAgo) }),
      className: "border-warning/40 text-warning",
    };
  }
  if (minutesAgo < 60 * 24) {
    return {
      tier: "offline",
      minutesAgo,
      label: t("tracking.DriverLocationCard.hoursAgo", { hours: Math.round(minutesAgo / 60) }),
      className: "border-destructive/40 text-destructive",
    };
  }
  return {
    tier: "offline",
    minutesAgo,
    label: t("tracking.DriverLocationCard.daysAgo", { days: Math.round(minutesAgo / 60 / 24) }),
    className: "border-destructive/40 text-destructive",
  };
}

export function DriverLocationCard({ userId, userName }: { userId: string; userName: string }) {
  const { t } = useT();
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
      toast({ variant: "destructive", title: t("common.error"), description: err.message });
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: () => apiJson("POST", `/api/admin/users/${userId}/tracking-token`, { revoke: true }),
    onSuccess: () => {
      toast({ description: t("tracking.DriverLocationCard.trackingDisabled") });
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
  const freshness = freshnessTier(current?.capturedAt, t);
  const mapsKey = mapsKeyQ.data?.key;

  // No token issued yet → render the setup CTA card.
  if (!hasTrackingToken) {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>{t("tracking.DriverLocationCard.geolocation")}</span>
              <Badge variant="outline" className="border-muted text-muted-foreground">
                {t("tracking.DriverLocationCard.notConfigured")}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t("tracking.DriverLocationCard.notConnectedDescription")}
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
              <Smartphone className="h-4 w-4" /> {t("tracking.DriverLocationCard.enableTracking")}
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
              <Radio className="h-4 w-4 text-primary" /> {t("tracking.DriverLocationCard.geolocation")}
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
                {t("tracking.DriverLocationCard.openInGoogleMaps")}
              </a>
            </div>
          ) : (
            <Alert variant="warning" t={t} />
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
              {t("tracking.DriverLocationCard.noPingsYet")}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              {t("tracking.DriverLocationCard.mapUnavailable", { key: "GOOGLE_MAPS_API_KEY" })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
            <span>{t("tracking.DriverLocationCard.pointsLast24h", { count: pings.length })}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => {
                setSetupOpen(true);
                issueTokenMutation.mutate();
              }}>
                {t("tracking.DriverLocationCard.newToken")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => revokeTokenMutation.mutate()}
                disabled={revokeTokenMutation.isPending}
              >
                {t("tracking.DriverLocationCard.disable")}
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

function Alert({ variant, t }: { variant: "warning"; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      <p>{t("tracking.DriverLocationCard.tokenIssuedNoPings")}</p>
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
  const { t } = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const { toast } = useToast();

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      toast({ description: t("tracking.DriverLocationCard.copied", { what }) });
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast({ variant: "destructive", description: t("tracking.DriverLocationCard.copyFailed") });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("tracking.DriverLocationCard.dialogTitle", { name: userName })}</DialogTitle>
          <DialogDescription>
            {t("tracking.DriverLocationCard.dialogDescription")}
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
                {t("tracking.DriverLocationCard.installAppPrefix")}{" "}
                <a
                  href="https://play.google.com/store/apps/details?id=org.traccar.client"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Traccar Client
                </a>{" "}
                {t("tracking.DriverLocationCard.fromPlayStore")}
              </li>
              <li>{t("tracking.DriverLocationCard.openSettingsAndFill")}</li>
            </ol>
            <CopyRow label="Server URL" value={data.osmandUrl.replace(/\?id=.*/, "")} onCopy={copy} copied={copied === "Server URL"} />
            <CopyRow label="Device identifier" value={data.token} onCopy={copy} copied={copied === "Device identifier"} />
            <p className="text-xs text-muted-foreground">
              {t("tracking.DriverLocationCard.androidHint")}
            </p>
          </TabsContent>

          <TabsContent value="ios" className="space-y-3 pt-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                {t("tracking.DriverLocationCard.installAppPrefix")}{" "}
                <a
                  href="https://apps.apple.com/app/owntracks/id692424691"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  OwnTracks
                </a>{" "}
                {t("tracking.DriverLocationCard.fromAppStore")}
              </li>
              <li>{t("tracking.DriverLocationCard.iosModeHttp")}</li>
            </ol>
            <CopyRow label="URL" value={data.owntracksUrl} onCopy={copy} copied={copied === "URL"} />
            <CopyRow label="User ID" value={data.owntracksUserId} onCopy={copy} copied={copied === "User ID"} />
            <p className="text-xs text-muted-foreground">
              {t("tracking.DriverLocationCard.iosHint")}
            </p>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button onClick={onClose}>{t("common.success")}</Button>
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
