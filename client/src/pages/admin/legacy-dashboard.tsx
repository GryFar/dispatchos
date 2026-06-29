import { FormEvent, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Gauge,
  LocateFixed,
  MapPinned,
  RadioTower,
  ShieldCheck,
  Target,
  Truck,
} from "lucide-react";
import type { DispatchBoard, ScoredLoad } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useT } from "@/lib/i18n";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function ppm(value: number) {
  return `$${value.toFixed(2)}/mi`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function verdictLabel(verdict: ScoredLoad["verdict"], t: (key: string) => string) {
  if (verdict === "book") return t("admin.legacyDashboard.verdictBook");
  if (verdict === "negotiate") return t("admin.legacyDashboard.verdictNegotiate");
  return t("admin.legacyDashboard.verdictStop");
}

function verdictClass(verdict: ScoredLoad["verdict"]) {
  if (verdict === "book") return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25";
  if (verdict === "negotiate") return "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25";
  return "bg-red-500/12 text-red-700 dark:text-red-300 border-red-500/25";
}

function confidenceClass(confidence: string) {
  if (confidence === "high") return "text-emerald-700 dark:text-emerald-300";
  if (confidence === "medium") return "text-amber-700 dark:text-amber-300";
  return "text-red-700 dark:text-red-300";
}

function scoreTone(score: number) {
  if (score >= 86) return "text-emerald-700 dark:text-emerald-300";
  if (score >= 70) return "text-amber-700 dark:text-amber-300";
  return "text-red-700 dark:text-red-300";
}

function MetricCard({
  label,
  value,
  helper,
  icon,
}: {
  label: string;
  value: string;
  helper: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="surface-card">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="mt-0.5 text-primary">{icon}</div>
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <p className="mt-1 text-xl font-semibold">{value}</p>
          <p className="mt-1 text-sm text-muted-foreground">{helper}</p>
        </div>
      </CardContent>
    </Card>
  );
}

const emptyClientForm = {
  name: "",
  mc: "",
  equipment: "enclosed_car_hauler",
  targetPpm: "2.40",
  minimumPpm: "2.05",
  mpg: "9.5",
  fuelPrice: "3.60",
  fixedCostPerMile: "0.40",
  city: "",
  state: "",
  lat: "",
  lng: "",
  preferredLanes: "Southeast, TX, Midwest",
  avoidStates: "",
};

const emptyLocationForm = {
  city: "",
  state: "",
  lat: "",
  lng: "",
  status: "empty",
  availableAt: "",
  notes: "",
};

const emptyLoadForm = {
  source: "Manual",
  originCity: "",
  originState: "",
  originLat: "",
  originLng: "",
  destinationCity: "",
  destinationState: "",
  destinationLat: "",
  destinationLng: "",
  rate: "",
  loadedMiles: "",
  pickupAt: "",
  deliveryAt: "",
  equipment: "enclosed_car_hauler",
  brokerName: "",
  brokerMc: "",
  brokerScore: "75",
  fraudRisk: "15",
  marketQuality: "70",
  notes: "",
};

const emptyBrokerForm = {
  brokerName: "",
  brokerMc: "",
};

const emptyDocumentForm = {
  clientId: "",
  loadId: "",
  type: "rate_confirmation",
  status: "received",
  fileName: "",
  storageUrl: "",
  notes: "",
};

const emptyUploadForm = {
  clientId: "",
  loadId: "",
  type: "bol",
  status: "received",
  notes: "",
};

const emptyTelegramForm = {
  command: "/loc",
  city: "",
  state: "",
  lat: "",
  lng: "",
  text: "",
};

const emptyEmailForm = {
  from: "",
  subject: "",
  body: "",
};

const sampleCsv = `source,originCity,originState,originLat,originLng,destinationCity,destinationState,destinationLat,destinationLng,rate,loadedMiles,pickupAt,deliveryAt,equipment,brokerName,brokerMc,brokerScore,fraudRisk,marketQuality,notes
Manual CSV,Tampa,FL,27.9506,-82.4572,Atlanta,GA,33.749,-84.388,2350,462,,,enclosed_car_hauler,Reliable Auto Logistics,MC-470488,90,8,82,CSV sample`;

function csvList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse a numeric form field, returning null for empty/non-finite input so the
 * caller can reject it instead of silently sending Number("")===0 or NaN to the
 * API. `min`/`max` optionally bound the accepted range.
 */
function parseFiniteNumber(value: string, min?: number, max?: number): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function localDateTimeToIso(value: string, fallbackMs: number) {
  if (!value) return new Date(Date.now() + fallbackMs).toISOString();
  return new Date(value).toISOString();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const { data: auth, isLoading } = useQuery<any>({
    queryKey: ["/api/auth/status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/auth/status");
      return response.json();
    },
  });
  const [setup, setSetup] = useState({ username: "owner", password: "" });
  const [login, setLogin] = useState({ username: "owner", password: "", token: "" });
  const [setupResult, setSetupResult] = useState<any>(null);
  const [error, setError] = useState("");

  async function refreshAuth() {
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
  }

  async function submitSetup(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const response = await apiRequest("POST", "/api/auth/setup", setup);
      setSetupResult(await response.json());
      await refreshAuth();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await apiRequest("POST", "/api/auth/login", login);
      await refreshAuth();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (isLoading) return <main className="min-h-screen bg-background p-6" />;
  if (auth?.authenticated) return <>{children}</>;

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-xl surface-card">
        <CardHeader>
          <CardTitle>{t("admin.legacyDashboard.securityTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm">{error}</div> : null}
          {!auth?.isConfigured ? (
            <form className="space-y-3" onSubmit={submitSetup}>
              <p className="text-sm text-muted-foreground">{t("admin.legacyDashboard.firstLaunchHint")}</p>
              <Field label={t("admin.legacyDashboard.username")}><Input value={setup.username} onChange={(e) => setSetup({ ...setup, username: e.target.value })} /></Field>
              <Field label={t("admin.legacyDashboard.passwordMin")}><Input type="password" value={setup.password} onChange={(e) => setSetup({ ...setup, password: e.target.value })} /></Field>
              <Button type="submit">{t("admin.legacyDashboard.createOwner2fa")}</Button>
              {setupResult ? (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
                  <p className="font-semibold">{t("admin.legacyDashboard.saveTotpNow")}</p>
                  <p className="mt-1 font-mono">{setupResult.totpSecret}</p>
                  <p className="mt-2 text-muted-foreground break-all">{setupResult.otpauthUrl}</p>
                  <p className="mt-2">{t("admin.legacyDashboard.addToAuthenticator")}</p>
                </div>
              ) : null}
            </form>
          ) : (
            <form className="space-y-3" onSubmit={submitLogin}>
              <p className="text-sm text-muted-foreground">{t("admin.legacyDashboard.loginHint")}</p>
              <Field label={t("admin.legacyDashboard.username")}><Input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} /></Field>
              <Field label={t("admin.legacyDashboard.password")}><Input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></Field>
              <Field label={t("admin.legacyDashboard.twoFaCode")}><Input inputMode="numeric" value={login.token} onChange={(e) => setLogin({ ...login, token: e.target.value })} /></Field>
              <Button type="submit">{t("common.login")}</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function OperatorForms({ clientId, clients, loads }: { clientId: string; clients: DispatchBoard["clients"]; loads: ScoredLoad[] }) {
  const { t } = useT();
  const [clientForm, setClientForm] = useState(emptyClientForm);
  const [locationForm, setLocationForm] = useState(emptyLocationForm);
  const [loadForm, setLoadForm] = useState(emptyLoadForm);
  const [brokerForm, setBrokerForm] = useState(emptyBrokerForm);
  const [documentForm, setDocumentForm] = useState(emptyDocumentForm);
  const [uploadForm, setUploadForm] = useState(emptyUploadForm);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [telegramForm, setTelegramForm] = useState(emptyTelegramForm);
  const [emailForm, setEmailForm] = useState(emptyEmailForm);
  const [csvText, setCsvText] = useState(sampleCsv);
  const [brokerResult, setBrokerResult] = useState<any>(null);
  const [drivePlan, setDrivePlan] = useState<any>(null);
  const [emailResult, setEmailResult] = useState<any>(null);
  const [telegramResult, setTelegramResult] = useState<any>(null);
  const [status, setStatus] = useState("");

  async function refresh(message: string) {
    await queryClient.invalidateQueries({ queryKey: ["/api/dispatch-board"] });
    setStatus(message);
  }

  async function submitClient(event: FormEvent) {
    event.preventDefault();
    const lat = parseFiniteNumber(clientForm.lat, -90, 90);
    const lng = parseFiniteNumber(clientForm.lng, -180, 180);
    const targetPpm = parseFiniteNumber(clientForm.targetPpm, 0);
    const minimumPpm = parseFiniteNumber(clientForm.minimumPpm, 0);
    const mpg = parseFiniteNumber(clientForm.mpg, 0);
    const fuelPrice = parseFiniteNumber(clientForm.fuelPrice, 0);
    const fixedCostPerMile = parseFiniteNumber(clientForm.fixedCostPerMile, 0);
    if (
      lat === null || lng === null || targetPpm === null || minimumPpm === null ||
      mpg === null || fuelPrice === null || fixedCostPerMile === null
    ) {
      setStatus(t("admin.legacyDashboard.statusInvalidNumbers"));
      return;
    }
    try {
      await apiRequest("POST", "/api/clients", {
        name: clientForm.name,
        mc: clientForm.mc,
        equipment: clientForm.equipment,
        targetPpm,
        minimumPpm,
        mpg,
        fuelPrice,
        fixedCostPerMile,
        preferredLanes: csvList(clientForm.preferredLanes),
        avoidStates: csvList(clientForm.avoidStates),
        currentLocation: {
          city: clientForm.city,
          state: clientForm.state,
          lat,
          lng,
          source: "manual_checkin",
          updatedAt: new Date().toISOString(),
          status: "empty",
          availableAt: new Date().toISOString(),
        },
      });
      setClientForm(emptyClientForm);
      await refresh(t("admin.legacyDashboard.statusClientSaved"));
    } catch (err: any) {
      setStatus(err?.message || String(err));
    }
  }

  async function submitLocation(event: FormEvent) {
    event.preventDefault();
    await apiRequest("PATCH", `/api/clients/${clientId}/location`, {
      city: locationForm.city,
      state: locationForm.state,
      lat: Number(locationForm.lat),
      lng: Number(locationForm.lng),
      source: "manual_checkin",
      status: locationForm.status,
      availableAt: localDateTimeToIso(locationForm.availableAt, 0),
      notes: locationForm.notes,
    });
    setLocationForm(emptyLocationForm);
    await refresh(t("admin.legacyDashboard.statusLocUpdated"));
  }

  async function submitLoad(event: FormEvent) {
    event.preventDefault();
    const originLat = parseFiniteNumber(loadForm.originLat, -90, 90);
    const originLng = parseFiniteNumber(loadForm.originLng, -180, 180);
    const destinationLat = parseFiniteNumber(loadForm.destinationLat, -90, 90);
    const destinationLng = parseFiniteNumber(loadForm.destinationLng, -180, 180);
    const rate = parseFiniteNumber(loadForm.rate, 0);
    const loadedMiles = parseFiniteNumber(loadForm.loadedMiles, 0);
    const brokerScore = parseFiniteNumber(loadForm.brokerScore, 0, 100);
    const fraudRisk = parseFiniteNumber(loadForm.fraudRisk, 0, 100);
    const marketQuality = parseFiniteNumber(loadForm.marketQuality, 0, 100);
    if (
      originLat === null || originLng === null || destinationLat === null || destinationLng === null ||
      rate === null || loadedMiles === null || brokerScore === null || fraudRisk === null || marketQuality === null
    ) {
      setStatus(t("admin.legacyDashboard.statusInvalidNumbers"));
      return;
    }
    try {
      await apiRequest("POST", "/api/loads", {
        source: loadForm.source,
        originCity: loadForm.originCity,
        originState: loadForm.originState,
        originLat,
        originLng,
        destinationCity: loadForm.destinationCity,
        destinationState: loadForm.destinationState,
        destinationLat,
        destinationLng,
        rate,
        loadedMiles,
        pickupAt: localDateTimeToIso(loadForm.pickupAt, 4 * 60 * 60 * 1000),
        deliveryAt: localDateTimeToIso(loadForm.deliveryAt, 36 * 60 * 60 * 1000),
        equipment: loadForm.equipment,
        brokerName: loadForm.brokerName,
        brokerMc: loadForm.brokerMc,
        brokerScore,
        fraudRisk,
        marketQuality,
        notes: loadForm.notes,
      });
      setLoadForm(emptyLoadForm);
      await refresh(t("admin.legacyDashboard.statusLoadSaved"));
    } catch (err: any) {
      setStatus(err?.message || String(err));
    }
  }

  async function submitBroker(event: FormEvent) {
    event.preventDefault();
    const response = await apiRequest("POST", "/api/broker/check", brokerForm);
    setBrokerResult(await response.json());
    await refresh(t("admin.legacyDashboard.statusBrokerSaved"));
  }

  async function submitDocument(event: FormEvent) {
    event.preventDefault();
    await apiRequest("POST", "/api/documents", {
      clientId: documentForm.clientId || clientId,
      loadId: documentForm.loadId || undefined,
      type: documentForm.type,
      status: documentForm.status,
      fileName: documentForm.fileName,
      storageUrl: documentForm.storageUrl || undefined,
      notes: documentForm.notes,
    });
    setDocumentForm(emptyDocumentForm);
    await refresh(t("admin.legacyDashboard.statusDocumentSaved"));
  }

  async function submitCsv(event: FormEvent) {
    event.preventDefault();
    const response = await apiRequest("POST", "/api/loads/import-csv", { csv: csvText });
    const result = await response.json();
    await refresh(t("admin.legacyDashboard.statusCsvImported", { created: result.created.length, errors: result.errors.length }));
  }

  async function fetchDrivePlan() {
    const response = await apiRequest("GET", `/api/drive/folder-plan?clientId=${clientId}`);
    setDrivePlan(await response.json());
  }

  async function createLocalDriveFolders() {
    const response = await apiRequest("POST", "/api/drive/create-local-folders", { clientId });
    setDrivePlan(await response.json());
    await refresh(t("admin.legacyDashboard.statusDriveFoldersCreated"));
  }

  async function submitTelegram(event: FormEvent) {
    event.preventDefault();
    const response = await apiRequest("POST", "/api/telegram/command", {
      clientId,
      command: telegramForm.command,
      text: telegramForm.text,
      city: telegramForm.city || undefined,
      state: telegramForm.state || undefined,
      lat: telegramForm.lat ? Number(telegramForm.lat) : undefined,
      lng: telegramForm.lng ? Number(telegramForm.lng) : undefined,
    });
    setTelegramResult(await response.json());
    await refresh(t("admin.legacyDashboard.statusTelegramProcessed", { command: telegramForm.command }));
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    const response = await apiRequest("POST", "/api/email/ingest", emailForm);
    setEmailResult(await response.json());
    await refresh(t("admin.legacyDashboard.statusEmailIngested"));
  }

  async function submitUpload(event: FormEvent) {
    event.preventDefault();
    if (!uploadFile) {
      setStatus(t("admin.legacyDashboard.statusChooseFile"));
      return;
    }
    try {
      const form = new FormData();
      form.append("clientId", uploadForm.clientId || clientId);
      if (uploadForm.loadId) form.append("loadId", uploadForm.loadId);
      form.append("type", uploadForm.type);
      form.append("status", uploadForm.status);
      form.append("notes", uploadForm.notes);
      form.append("file", uploadFile);
      // credentials:"include" mirrors apiRequest so the cookie-based session is
      // sent with the multipart upload (FormData can't go through apiRequest's
      // JSON body, so we keep raw fetch here).
      const response = await fetch("/api/documents/upload", { method: "POST", body: form, credentials: "include" });
      if (!response.ok) throw new Error(await response.text());
      setUploadFile(null);
      setUploadForm(emptyUploadForm);
      await refresh(t("admin.legacyDashboard.statusFileUploaded"));
    } catch (err: any) {
      setStatus(err?.message || String(err));
    }
  }

  return (
    <Card className="surface-card">
      <CardHeader>
        <CardTitle className="text-lg">{t("admin.legacyDashboard.operatorWorkflow")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {status ? <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm">{status}</div> : null}

        <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitClient}>
          <h3 className="font-semibold">{t("admin.legacyDashboard.step1AddClient")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("admin.legacyDashboard.name")}><Input required value={clientForm.name} onChange={(e) => setClientForm({ ...clientForm, name: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.mc")}><Input required value={clientForm.mc} onChange={(e) => setClientForm({ ...clientForm, mc: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.equipment")}>
              <select className="form-select" value={clientForm.equipment} onChange={(e) => setClientForm({ ...clientForm, equipment: e.target.value })}>
                <option value="enclosed_car_hauler">{t("admin.legacyDashboard.equipEnclosed")}</option>
                <option value="open_car_hauler">{t("admin.legacyDashboard.equipOpen")}</option>
                <option value="hotshot_flatbed">{t("admin.legacyDashboard.equipHotshot")}</option>
                <option value="sprinter_van">{t("admin.legacyDashboard.equipSprinter")}</option>
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.city")}><Input required value={clientForm.city} onChange={(e) => setClientForm({ ...clientForm, city: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.state")}><Input required value={clientForm.state} onChange={(e) => setClientForm({ ...clientForm, state: e.target.value.toUpperCase() })} /></Field>
            <Field label={t("admin.legacyDashboard.lat")}><Input required value={clientForm.lat} onChange={(e) => setClientForm({ ...clientForm, lat: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.lng")}><Input required value={clientForm.lng} onChange={(e) => setClientForm({ ...clientForm, lng: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.targetPpm")}><Input required value={clientForm.targetPpm} onChange={(e) => setClientForm({ ...clientForm, targetPpm: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.minimumPpm")}><Input required value={clientForm.minimumPpm} onChange={(e) => setClientForm({ ...clientForm, minimumPpm: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.mpg")}><Input required value={clientForm.mpg} onChange={(e) => setClientForm({ ...clientForm, mpg: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.fuelPerGal")}><Input required value={clientForm.fuelPrice} onChange={(e) => setClientForm({ ...clientForm, fuelPrice: e.target.value })} /></Field>
          </div>
          <Field label={t("admin.legacyDashboard.preferredLanesCsv")}><Input value={clientForm.preferredLanes} onChange={(e) => setClientForm({ ...clientForm, preferredLanes: e.target.value })} /></Field>
          <Field label={t("admin.legacyDashboard.avoidStatesCsv")}><Input value={clientForm.avoidStates} onChange={(e) => setClientForm({ ...clientForm, avoidStates: e.target.value.toUpperCase() })} /></Field>
          <Button data-testid="button-add-client" type="submit">{t("admin.legacyDashboard.saveClient")}</Button>
        </form>

        <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitLocation}>
          <h3 className="font-semibold">{t("admin.legacyDashboard.step2UpdateLoc")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("admin.legacyDashboard.city")}><Input required value={locationForm.city} onChange={(e) => setLocationForm({ ...locationForm, city: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.state")}><Input required value={locationForm.state} onChange={(e) => setLocationForm({ ...locationForm, state: e.target.value.toUpperCase() })} /></Field>
            <Field label={t("admin.legacyDashboard.lat")}><Input required value={locationForm.lat} onChange={(e) => setLocationForm({ ...locationForm, lat: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.lng")}><Input required value={locationForm.lng} onChange={(e) => setLocationForm({ ...locationForm, lng: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.status")}>
              <select className="form-select" value={locationForm.status} onChange={(e) => setLocationForm({ ...locationForm, status: e.target.value })}>
                <option value="empty">{t("admin.legacyDashboard.statusEmpty")}</option>
                <option value="loaded">{t("admin.legacyDashboard.statusLoaded")}</option>
                <option value="at_pickup">{t("admin.legacyDashboard.statusAtPickup")}</option>
                <option value="at_delivery">{t("admin.legacyDashboard.statusAtDelivery")}</option>
                <option value="delivered">{t("admin.legacyDashboard.statusDelivered")}</option>
                <option value="offline">{t("admin.legacyDashboard.statusOffline")}</option>
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.availableAt")}><Input type="datetime-local" value={locationForm.availableAt} onChange={(e) => setLocationForm({ ...locationForm, availableAt: e.target.value })} /></Field>
          </div>
          <Field label={t("admin.legacyDashboard.notes")}><Textarea value={locationForm.notes} onChange={(e) => setLocationForm({ ...locationForm, notes: e.target.value })} /></Field>
          <Button data-testid="button-update-location" type="submit">{t("admin.legacyDashboard.updateLocation")}</Button>
        </form>

        <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitLoad}>
          <h3 className="font-semibold">{t("admin.legacyDashboard.step3AddLoad")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("admin.legacyDashboard.source")}><Input value={loadForm.source} onChange={(e) => setLoadForm({ ...loadForm, source: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.equipment")}>
              <select className="form-select" value={loadForm.equipment} onChange={(e) => setLoadForm({ ...loadForm, equipment: e.target.value })}>
                <option value="enclosed_car_hauler">{t("admin.legacyDashboard.equipEnclosed")}</option>
                <option value="open_car_hauler">{t("admin.legacyDashboard.equipOpen")}</option>
                <option value="hotshot_flatbed">{t("admin.legacyDashboard.equipHotshot")}</option>
                <option value="sprinter_van">{t("admin.legacyDashboard.equipSprinter")}</option>
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.originCity")}><Input required value={loadForm.originCity} onChange={(e) => setLoadForm({ ...loadForm, originCity: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.originState")}><Input required value={loadForm.originState} onChange={(e) => setLoadForm({ ...loadForm, originState: e.target.value.toUpperCase() })} /></Field>
            <Field label={t("admin.legacyDashboard.originLat")}><Input required value={loadForm.originLat} onChange={(e) => setLoadForm({ ...loadForm, originLat: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.originLng")}><Input required value={loadForm.originLng} onChange={(e) => setLoadForm({ ...loadForm, originLng: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.destinationCity")}><Input required value={loadForm.destinationCity} onChange={(e) => setLoadForm({ ...loadForm, destinationCity: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.destinationState")}><Input required value={loadForm.destinationState} onChange={(e) => setLoadForm({ ...loadForm, destinationState: e.target.value.toUpperCase() })} /></Field>
            <Field label={t("admin.legacyDashboard.destinationLat")}><Input required value={loadForm.destinationLat} onChange={(e) => setLoadForm({ ...loadForm, destinationLat: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.destinationLng")}><Input required value={loadForm.destinationLng} onChange={(e) => setLoadForm({ ...loadForm, destinationLng: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.rate")}><Input required value={loadForm.rate} onChange={(e) => setLoadForm({ ...loadForm, rate: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.loadedMiles")}><Input required value={loadForm.loadedMiles} onChange={(e) => setLoadForm({ ...loadForm, loadedMiles: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.pickup")}><Input type="datetime-local" value={loadForm.pickupAt} onChange={(e) => setLoadForm({ ...loadForm, pickupAt: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.delivery")}><Input type="datetime-local" value={loadForm.deliveryAt} onChange={(e) => setLoadForm({ ...loadForm, deliveryAt: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.broker")}><Input required value={loadForm.brokerName} onChange={(e) => setLoadForm({ ...loadForm, brokerName: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.brokerMc")}><Input required value={loadForm.brokerMc} onChange={(e) => setLoadForm({ ...loadForm, brokerMc: e.target.value })} /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("admin.legacyDashboard.brokerScore")}><Input value={loadForm.brokerScore} onChange={(e) => setLoadForm({ ...loadForm, brokerScore: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.fraudRisk")}><Input value={loadForm.fraudRisk} onChange={(e) => setLoadForm({ ...loadForm, fraudRisk: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.marketQuality")}><Input value={loadForm.marketQuality} onChange={(e) => setLoadForm({ ...loadForm, marketQuality: e.target.value })} /></Field>
          </div>
          <Field label={t("admin.legacyDashboard.notes")}><Textarea value={loadForm.notes} onChange={(e) => setLoadForm({ ...loadForm, notes: e.target.value })} /></Field>
          <Button data-testid="button-add-load" type="submit">{t("admin.legacyDashboard.saveLoad")}</Button>
        </form>

        <div className="grid gap-4 xl:grid-cols-2">
          <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitBroker}>
            <h3 className="font-semibold">{t("admin.legacyDashboard.step4BrokerCheck")}</h3>
            <Field label={t("admin.legacyDashboard.brokerName")}><Input value={brokerForm.brokerName} onChange={(e) => setBrokerForm({ ...brokerForm, brokerName: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.brokerMc")}><Input required value={brokerForm.brokerMc} onChange={(e) => setBrokerForm({ ...brokerForm, brokerMc: e.target.value })} /></Field>
            <Button data-testid="button-broker-check" type="submit">{t("admin.legacyDashboard.checkBroker")}</Button>
            {brokerResult ? (
              <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
                <p className="font-semibold">{t("admin.legacyDashboard.verdictRiskLine", { verdict: brokerResult.verdict, risk: brokerResult.riskScore })}</p>
                <p className="text-muted-foreground">{t("admin.legacyDashboard.authorityLine", { status: brokerResult.authorityStatus, months: brokerResult.authorityAgeMonths })}</p>
                {brokerResult.flags?.map((flag: string) => <p className="mt-1 text-amber-700 dark:text-amber-300" key={flag}>• {flag}</p>)}
              </div>
            ) : null}
          </form>

          <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitDocument}>
            <h3 className="font-semibold">{t("admin.legacyDashboard.step5DocumentMetadata")}</h3>
            <Field label={t("admin.legacyDashboard.client")}>
              <select className="form-select" value={documentForm.clientId || clientId} onChange={(e) => setDocumentForm({ ...documentForm, clientId: e.target.value })}>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}{(client as any).contactPersonName ? ` (${(client as any).contactPersonName})` : ""} · {client.mc}</option>)}
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.loadOptional")}>
              <select className="form-select" value={documentForm.loadId} onChange={(e) => setDocumentForm({ ...documentForm, loadId: e.target.value })}>
                <option value="">{t("admin.legacyDashboard.noLoadSelected")}</option>
                {loads.map((load) => <option key={load.id} value={load.id}>{load.originCity} → {load.destinationCity}</option>)}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("admin.legacyDashboard.type")}>
                <select className="form-select" value={documentForm.type} onChange={(e) => setDocumentForm({ ...documentForm, type: e.target.value })}>
                  <option value="rate_confirmation">{t("admin.legacyDashboard.docRateConfirmation")}</option>
                  <option value="bol">{t("admin.legacyDashboard.docBol")}</option>
                  <option value="pod">{t("admin.legacyDashboard.docPod")}</option>
                  <option value="coi">{t("admin.legacyDashboard.docCoi")}</option>
                  <option value="w9">{t("admin.legacyDashboard.docW9")}</option>
                  <option value="authorization_letter">{t("admin.legacyDashboard.docAuthLetter")}</option>
                  <option value="other">{t("admin.legacyDashboard.docOther")}</option>
                </select>
              </Field>
              <Field label={t("admin.legacyDashboard.status")}>
                <select className="form-select" value={documentForm.status} onChange={(e) => setDocumentForm({ ...documentForm, status: e.target.value })}>
                  <option value="needed">{t("admin.legacyDashboard.docStatusNeeded")}</option>
                  <option value="received">{t("admin.legacyDashboard.docStatusReceived")}</option>
                  <option value="submitted">{t("admin.legacyDashboard.docStatusSubmitted")}</option>
                  <option value="verified">{t("admin.legacyDashboard.docStatusVerified")}</option>
                  <option value="issue">{t("admin.legacyDashboard.docStatusIssue")}</option>
                </select>
              </Field>
            </div>
            <Field label={t("admin.legacyDashboard.fileName")}><Input required value={documentForm.fileName} onChange={(e) => setDocumentForm({ ...documentForm, fileName: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.storageUrlOptional")}><Input value={documentForm.storageUrl} onChange={(e) => setDocumentForm({ ...documentForm, storageUrl: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.notes")}><Textarea value={documentForm.notes} onChange={(e) => setDocumentForm({ ...documentForm, notes: e.target.value })} /></Field>
            <Button data-testid="button-save-document" type="submit">{t("admin.legacyDashboard.saveDocument")}</Button>
          </form>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitCsv}>
            <h3 className="font-semibold">{t("admin.legacyDashboard.step6CsvImport")}</h3>
            <p className="text-sm text-muted-foreground">{t("admin.legacyDashboard.csvImportHint")}</p>
            <Textarea className="min-h-[180px] font-mono text-xs" value={csvText} onChange={(e) => setCsvText(e.target.value)} />
            <Button data-testid="button-import-csv" type="submit">{t("admin.legacyDashboard.importCsv")}</Button>
          </form>

          <div className="space-y-3 rounded-2xl border border-border p-4">
            <h3 className="font-semibold">{t("admin.legacyDashboard.step7DriveFolderPlan")}</h3>
            <p className="text-sm text-muted-foreground">{t("admin.legacyDashboard.drivePlanHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button data-testid="button-drive-plan" type="button" variant="outline" onClick={fetchDrivePlan}>{t("admin.legacyDashboard.generatePlan")}</Button>
              <Button data-testid="button-drive-create-local" type="button" onClick={createLocalDriveFolders}>{t("admin.legacyDashboard.createLocalFolders")}</Button>
            </div>
            {drivePlan ? (
              <div className="space-y-2">
                {drivePlan.folders.map((folder: any) => (
                  <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm" key={folder.clientId}>
                    <p className="font-medium">{folder.path}</p>
                    <p className="text-muted-foreground">{folder.subfolders.join(" / ")}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitUpload}>
            <h3 className="font-semibold">{t("admin.legacyDashboard.step8Upload")}</h3>
            <Field label={t("admin.legacyDashboard.client")}>
              <select className="form-select" value={uploadForm.clientId || clientId} onChange={(e) => setUploadForm({ ...uploadForm, clientId: e.target.value })}>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}{(client as any).contactPersonName ? ` (${(client as any).contactPersonName})` : ""}</option>)}
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.load")}>
              <select className="form-select" value={uploadForm.loadId} onChange={(e) => setUploadForm({ ...uploadForm, loadId: e.target.value })}>
                <option value="">{t("admin.legacyDashboard.noLoadSelected")}</option>
                {loads.map((load) => <option key={load.id} value={load.id}>{load.originCity} → {load.destinationCity}</option>)}
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.type")}>
              <select className="form-select" value={uploadForm.type} onChange={(e) => setUploadForm({ ...uploadForm, type: e.target.value })}>
                <option value="rate_confirmation">{t("admin.legacyDashboard.docRateConfirmation")}</option>
                <option value="bol">{t("admin.legacyDashboard.docBol")}</option>
                <option value="pod">{t("admin.legacyDashboard.docPod")}</option>
                <option value="coi">{t("admin.legacyDashboard.docCoi")}</option>
                <option value="w9">{t("admin.legacyDashboard.docW9")}</option>
                <option value="authorization_letter">{t("admin.legacyDashboard.docAuthLetter")}</option>
                <option value="other">{t("admin.legacyDashboard.docOther")}</option>
              </select>
            </Field>
            <Field label={t("admin.legacyDashboard.file")}><Input type="file" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} /></Field>
            <Field label={t("admin.legacyDashboard.notes")}><Textarea value={uploadForm.notes} onChange={(e) => setUploadForm({ ...uploadForm, notes: e.target.value })} /></Field>
            <Button data-testid="button-upload-document" type="submit">{t("admin.legacyDashboard.uploadFile")}</Button>
          </form>

          <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitTelegram}>
            <h3 className="font-semibold">{t("admin.legacyDashboard.step9TelegramCommands")}</h3>
            <Field label={t("admin.legacyDashboard.command")}>
              <select className="form-select" value={telegramForm.command} onChange={(e) => setTelegramForm({ ...telegramForm, command: e.target.value })}>
                <option value="/loc">/loc</option>
                <option value="/yes">/yes</option>
                <option value="/no">/no</option>
                <option value="/nego">/nego</option>
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("admin.legacyDashboard.city")}><Input value={telegramForm.city} onChange={(e) => setTelegramForm({ ...telegramForm, city: e.target.value })} /></Field>
              <Field label={t("admin.legacyDashboard.state")}><Input value={telegramForm.state} onChange={(e) => setTelegramForm({ ...telegramForm, state: e.target.value.toUpperCase() })} /></Field>
              <Field label={t("admin.legacyDashboard.lat")}><Input value={telegramForm.lat} onChange={(e) => setTelegramForm({ ...telegramForm, lat: e.target.value })} /></Field>
              <Field label={t("admin.legacyDashboard.lng")}><Input value={telegramForm.lng} onChange={(e) => setTelegramForm({ ...telegramForm, lng: e.target.value })} /></Field>
            </div>
            <Field label={t("admin.legacyDashboard.text")}><Textarea value={telegramForm.text} onChange={(e) => setTelegramForm({ ...telegramForm, text: e.target.value })} /></Field>
            <Button data-testid="button-telegram-command" type="submit">{t("admin.legacyDashboard.processCommand")}</Button>
            {telegramResult ? <p className="text-sm text-muted-foreground">{telegramResult.reply}</p> : null}
          </form>

          <form className="space-y-3 rounded-2xl border border-border p-4" onSubmit={submitEmail}>
            <h3 className="font-semibold">{t("admin.legacyDashboard.step10EmailIngest")}</h3>
            <Field label={t("admin.legacyDashboard.from")}><Input required value={emailForm.from} onChange={(e) => setEmailForm({ ...emailForm, from: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.subject")}><Input required value={emailForm.subject} onChange={(e) => setEmailForm({ ...emailForm, subject: e.target.value })} /></Field>
            <Field label={t("admin.legacyDashboard.body")}><Textarea required className="min-h-[150px]" value={emailForm.body} onChange={(e) => setEmailForm({ ...emailForm, body: e.target.value })} /></Field>
            <Button data-testid="button-email-ingest" type="submit">{t("admin.legacyDashboard.ingestEmail")}</Button>
            {emailResult ? (
              <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
                <p className="font-medium">{t("admin.legacyDashboard.possibleLoad", { value: String(emailResult.parsed?.possibleLoad) })}</p>
                <p className="text-muted-foreground">{JSON.stringify(emailResult.parsed?.extracted)}</p>
              </div>
            ) : null}
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadCard({ load, rank }: { load: ScoredLoad; rank: number }) {
  const { t } = useT();
  return (
    <article className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">#{rank}</Badge>
            <Badge className={verdictClass(load.verdict)} variant="outline">
              {verdictLabel(load.verdict, t)}
            </Badge>
            <Badge variant="secondary">{load.source}</Badge>
          </div>
          <h3 className="mt-3 text-lg font-semibold">
            {load.originCity}, {load.originState}
            <ArrowRight className="mx-2 inline h-4 w-4 text-muted-foreground" />
            {load.destinationCity}, {load.destinationState}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {load.brokerName} · {load.brokerMc} · {t("admin.legacyDashboard.pickupAt", { time: formatTime(load.pickupAt) })}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t("admin.legacyDashboard.dispatchScore")}</p>
          <p className={`text-2xl font-semibold ${scoreTone(load.dispatchScore)}`}>{load.dispatchScore}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="mini-stat">
          <span>{t("admin.legacyDashboard.gross")}</span>
          <strong>{money.format(load.rate)}</strong>
        </div>
        <div className="mini-stat">
          <span>{t("admin.legacyDashboard.netTotalPpm")}</span>
          <strong>{ppm(load.netPpmTotal)}</strong>
        </div>
        <div className="mini-stat">
          <span>{t("admin.legacyDashboard.loadedTotal")}</span>
          <strong>
            {t("admin.legacyDashboard.milesPair", { loaded: load.loadedMiles, total: load.totalMiles })}
          </strong>
        </div>
        <div className="mini-stat">
          <span>{t("admin.legacyDashboard.deadhead")}</span>
          <strong>
            {t("admin.legacyDashboard.deadheadValue", { miles: load.deadheadMiles, percent: Math.round(load.deadheadRatio * 100) })}
          </strong>
        </div>
        <div className="mini-stat">
          <span>{t("admin.legacyDashboard.estNet")}</span>
          <strong>{money.format(load.estimatedNet)}</strong>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-muted/50 p-3">
        <p className="text-sm">
          <span className="font-medium">{t("admin.legacyDashboard.whyRanked")}</span> {load.rankReason}
        </p>
        {load.counterOffer ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            {t("admin.legacyDashboard.counterOfferSuggestion", { amount: money.format(load.counterOffer) })}
          </p>
        ) : null}
      </div>

      {load.warnings.length ? (
        <div className="mt-3 space-y-2">
          {load.warnings.map((warning) => (
            <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-sm" key={warning}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * LegacyDashboardPage — это бывший v1.2.7 App.tsx, перенесённый под
 * /admin/legacy-dashboard. RoleGate в App.tsx уже проверил, что юзер — admin.
 * AuthGate ниже остаётся как no-op: он переспросит /api/auth/status, увидит
 * `authenticated: true`, и сразу пропустит DispatchDashboard.
 *
 * После Phase 3 — этот файл удалить целиком.
 */
export default function LegacyDashboardPage() {
  return (
    <AuthGate>
      <DispatchDashboard />
    </AuthGate>
  );
}

function DispatchDashboard() {
  const { t } = useT();
  const [clientId, setClientId] = useState("ivan-enclosed-01");
  const { data, isLoading, isError } = useQuery<DispatchBoard>({
    queryKey: ["/api/dispatch-board", clientId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/dispatch-board?clientId=${clientId}`);
      return response.json();
    },
  });
  const { data: auditEvents = [] } = useQuery<Array<{ id: string; eventType: string; entityType: string; entityId: string; createdAt: string }>>({
    queryKey: ["/api/audit"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/audit?limit=8");
      return response.json();
    },
  });
  const { data: integrationStatus } = useQuery<any>({
    queryKey: ["/api/integrations/status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/integrations/status");
      return response.json();
    },
  });
  const { data: systemStatus } = useQuery<any>({
    queryKey: ["/api/system/status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/system/status");
      return response.json();
    },
  });
  const { data: portalStatus } = useQuery<any>({
    queryKey: ["/api/portal/status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/portal/status");
      return response.json();
    },
  });
  const [weeklyReport, setWeeklyReport] = useState<any>(null);

  async function generateWeeklyReport() {
    const response = await apiRequest("GET", `/api/reports/weekly?clientId=${clientId}`);
    setWeeklyReport(await response.json());
  }

  const bestComparison = useMemo(() => {
    if (!data || data.loads.length < 2) return null;
    const highestGross = [...data.loads].sort((a, b) => b.rate - a.rate)[0];
    const best = data.topRecommendation;
    if (highestGross.id === best.id) {
      return t("admin.legacyDashboard.comparisonSameBest", { gross: money.format(best.rate), netPpm: ppm(best.netPpmTotal) });
    }
    return t("admin.legacyDashboard.comparisonBetter", {
      bestOrigin: best.originCity,
      bestDest: best.destinationCity,
      grossOrigin: highestGross.originCity,
      grossDest: highestGross.destinationCity,
      bestGross: money.format(best.rate),
      highestGross: money.format(highestGross.rate),
      bestNetPpm: ppm(best.netPpmTotal),
      highestNetPpm: ppm(highestGross.netPpmTotal),
    });
  }, [data, t]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto max-w-7xl space-y-4">
          <div className="h-10 w-80 animate-pulse rounded-xl bg-muted" />
          <div className="grid gap-4 md:grid-cols-4">
            {[1, 2, 3, 4].map((item) => (
              <div className="h-32 animate-pulse rounded-2xl bg-muted" key={item} />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>{t("admin.legacyDashboard.loadFailedTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{t("admin.legacyDashboard.loadFailedHint")}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const client = data.selectedClient;
  const best = data.topRecommendation;

  // Guard: with zero loads the server sends topRecommendation=undefined; the
  // render body below dereferences best.* / client.* unconditionally and would
  // throw a blank screen. Show an empty-state instead.
  if (!best || !client) {
    return (
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-7xl px-5 py-20 text-center text-muted-foreground">
          {t("admin.legacyDashboard.emptyState")}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground">
                <RadioTower className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">DispatchOS</p>
                <h1 className="text-xl font-semibold">{t("admin.legacyDashboard.headerTitle")}</h1>
              </div>
            </div>
            <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
              {t("admin.legacyDashboard.headerSubtitle")}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger className="w-full sm:w-[260px]" data-testid="select-client">
                <SelectValue placeholder={t("admin.legacyDashboard.selectClient")} />
              </SelectTrigger>
              <SelectContent>
                {data.clients.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {item.equipment.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button data-testid="button-request-location" variant="outline">
              <LocateFixed className="mr-2 h-4 w-4" />
              {t("admin.legacyDashboard.sendLoc")}
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<MapPinned className="h-5 w-5" />}
            label={t("admin.legacyDashboard.currentPosition")}
            value={`${client.currentLocation.city}, ${client.currentLocation.state}`}
            helper={t("admin.legacyDashboard.updatedMinAgo", { source: client.currentLocation.source.replaceAll("_", " "), minutes: best.locationAgeMinutes })}
          />
          <MetricCard
            icon={<Clock3 className="h-5 w-5" />}
            label={t("admin.legacyDashboard.locationConfidence")}
            value={`${best.locationConfidence.toUpperCase()} · ${best.locationAgeMinutes}m`}
            helper={data.locationPolicy.command}
          />
          <MetricCard
            icon={<Target className="h-5 w-5" />}
            label={t("admin.legacyDashboard.targetMinimum")}
            value={`${ppm(client.targetPpm)} / ${ppm(client.minimumPpm)}`}
            helper={t("admin.legacyDashboard.mpgFuel", { mpg: client.mpg, fuel: money.format(client.fuelPrice) })}
          />
          <MetricCard
            icon={<Gauge className="h-5 w-5" />}
            label={t("admin.legacyDashboard.bestLoad")}
            value={`${best.originCity} → ${best.destinationCity}`}
            helper={t("admin.legacyDashboard.grossNetTotal", { gross: money.format(best.rate), netPpm: ppm(best.netPpmTotal) })}
          />
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
          <Card className="surface-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                {t("admin.legacyDashboard.bestChoiceNow")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-2xl bg-primary p-5 text-primary-foreground">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-sm opacity-80">{t("admin.legacyDashboard.recommendationRank", { rank: data.loads.findIndex((load) => load.id === best.id) + 1 })}</p>
                    <h2 className="mt-1 text-xl font-semibold">
                      {best.originCity}, {best.originState} → {best.destinationCity}, {best.destinationState}
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm opacity-90">{bestComparison}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm opacity-80">{t("admin.legacyDashboard.score")}</p>
                    <p className="text-3xl font-semibold">{best.dispatchScore}</p>
                  </div>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] opacity-70">{t("admin.legacyDashboard.netTotal")}</p>
                    <p className="text-lg font-semibold">{ppm(best.netPpmTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] opacity-70">{t("admin.legacyDashboard.deadhead")}</p>
                    <p className="text-lg font-semibold">{t("admin.legacyDashboard.milesValue", { miles: best.deadheadMiles })}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] opacity-70">{t("admin.legacyDashboard.net")}</p>
                    <p className="text-lg font-semibold">{money.format(best.estimatedNet)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] opacity-70">{t("admin.legacyDashboard.verdict")}</p>
                    <p className="text-lg font-semibold">{verdictLabel(best.verdict, t)}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="surface-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" />
                {t("admin.legacyDashboard.scoringWeights")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                ["admin.legacyDashboard.weightNetTotalPpm", 42],
                ["admin.legacyDashboard.weightLowDeadhead", 18],
                ["admin.legacyDashboard.weightPickupFeasibility", 15],
                ["admin.legacyDashboard.weightBrokerSafety", 12],
                ["admin.legacyDashboard.weightDestinationMarket", 8],
                ["admin.legacyDashboard.weightLocationConfidence", 5],
              ].map(([labelKey, value]) => (
                <div key={labelKey}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span>{t(String(labelKey))}</span>
                    <span className="text-muted-foreground">{value}%</span>
                  </div>
                  <Progress value={Number(value)} />
                </div>
              ))}
              <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                {t("admin.legacyDashboard.scoringRule")}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[0.75fr_1.25fr]">
          <div className="space-y-5">
            <Card className="surface-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Truck className="h-5 w-5 text-primary" />
                  {t("admin.legacyDashboard.clientLiveState")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-2xl border border-border bg-muted/40 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t("admin.legacyDashboard.driver")}</p>
                  <p className="mt-1 text-lg font-semibold">
                    {client.name} · {client.mc}
                  </p>
                  {(client as any).contactPersonName && (
                    <p className="text-xs text-muted-foreground">{(client as any).contactPersonName}</p>
                  )}
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("admin.legacyDashboard.equipmentStatusLine", { equipment: client.equipment.replaceAll("_", " "), status: client.currentLocation.status.replaceAll("_", " ") })}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="mini-stat">
                    <span>{t("admin.legacyDashboard.available")}</span>
                    <strong>{formatTime(client.currentLocation.availableAt)}</strong>
                  </div>
                  <div className="mini-stat">
                    <span>{t("admin.legacyDashboard.positionAge")}</span>
                    <strong className={confidenceClass(best.locationConfidence)}>{t("admin.legacyDashboard.minutesValue", { minutes: best.locationAgeMinutes })}</strong>
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium">{t("admin.legacyDashboard.preferredLanes")}</p>
                  <div className="flex flex-wrap gap-2">
                    {client.preferredLanes.map((lane) => (
                      <Badge key={lane} variant="secondary">
                        {lane}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                  {client.currentLocation.notes}
                </div>
              </CardContent>
            </Card>

            <Card className="surface-card">
              <CardHeader>
                <CardTitle className="text-lg">{t("admin.legacyDashboard.auditBackup")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button asChild data-testid="button-backup-export" variant="outline">
                  <a href="/api/backup/export">{t("admin.legacyDashboard.exportJsonBackup")}</a>
                </Button>
                <div className="space-y-2">
                  {auditEvents.map((event) => (
                    <div className="rounded-lg border border-border bg-muted/35 p-2 text-xs" key={event.id}>
                      <p className="font-medium">{event.eventType}</p>
                      <p className="text-muted-foreground">{event.entityType} · {event.entityId}</p>
                      <p className="text-muted-foreground">{formatTime(event.createdAt)}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="surface-card">
              <CardHeader>
                <CardTitle className="text-lg">{t("admin.legacyDashboard.integrationsWeeklyReport")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  {systemStatus?.checks?.map((item: any) => (
                    <div className="rounded-lg border border-border bg-muted/35 p-2 text-xs" key={item.key}>
                      <p className="font-medium">{item.label}</p>
                      <p className={item.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>
                        {item.ok ? t("admin.legacyDashboard.ok") : t("admin.legacyDashboard.needsAttention")}{item.value ? ` · ${item.value}` : ""}
                      </p>
                    </div>
                  ))}
                  {integrationStatus?.integrations?.map((item: any) => (
                    <div className="rounded-lg border border-border bg-muted/35 p-2 text-xs" key={item.key}>
                      <p className="font-medium">{item.label}</p>
                      <p className="text-muted-foreground">{t("admin.legacyDashboard.statusLabel", { status: item.status })}</p>
                      {item.missing?.length ? <p className="text-amber-700 dark:text-amber-300">{t("admin.legacyDashboard.missingLabel", { missing: item.missing.join(", ") })}</p> : null}
                    </div>
                  ))}
                </div>
                <Button data-testid="button-weekly-report" type="button" onClick={generateWeeklyReport}>{t("admin.legacyDashboard.generateWeeklyReport")}</Button>
                {portalStatus ? (
                  <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
                    <p className="font-semibold">{t("admin.legacyDashboard.portalReadiness")}</p>
                    <p>{t("admin.legacyDashboard.portalAdmin", { status: portalStatus.adminPortal.status })}</p>
                    <p>{t("admin.legacyDashboard.portalClient", { status: portalStatus.clientPortal.status })}</p>
                    <p>{t("admin.legacyDashboard.portalModeration", { status: portalStatus.moderation.status })}</p>
                  </div>
                ) : null}
                {weeklyReport ? (
                  <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
                    <p className="font-semibold">{t("admin.legacyDashboard.weeklyReportTitle", { name: weeklyReport.client.name })}</p>
                    <p>{t("admin.legacyDashboard.recommendedLoads", { count: weeklyReport.summary.recommendedLoads })}</p>
                    <p>{t("admin.legacyDashboard.grossPotential", { amount: money.format(weeklyReport.summary.grossPotential) })}</p>
                    <p>{t("admin.legacyDashboard.dispatchFee", { amount: money.format(weeklyReport.summary.totalDispatchFee) })}</p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <section className="space-y-4" aria-label={t("admin.legacyDashboard.rankedLoadsAria")}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{t("admin.legacyDashboard.rankedLoadInbox")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("admin.legacyDashboard.rankedLoadInboxHint")}
                </p>
              </div>
              <Badge variant="outline">{t("admin.legacyDashboard.matchingLoads", { count: data.loads.length })}</Badge>
            </div>
            {data.loads.map((load, index) => (
              <LoadCard key={load.id} load={load} rank={index + 1} />
            ))}
          </section>
        </div>

        <div className="mt-6">
          <OperatorForms clientId={client.id} clients={data.clients} loads={data.loads} />
        </div>
      </section>
    </main>
  );
}
