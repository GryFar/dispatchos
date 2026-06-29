// ===========================================================================
// driver/load-create.tsx — Owner-operator self-dispatch load creation form
// ===========================================================================
//
// Accessible only to drivers with persona=owner_operator (enforced server-side
// at POST /api/me/loads). The UI conditionally shows the button only for
// owner-operators, but the server validates independently.
//
// Form fields: origin (city+state), destination (city+state), rate, pickup
// datetime, delivery datetime, equipment select, brokerName, brokerMc, notes.
//
// On submit: POST /api/me/loads — the server injects clientId and driverId
// from the session (never trusted from the client body).
// ---------------------------------------------------------------------------

import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Truck } from "lucide-react";
import type { Equipment } from "@shared/schema";
import { apiJson } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EQUIPMENT_OPTIONS: { value: Equipment; label: string }[] = [
  { value: "enclosed_car_hauler", label: "Enclosed Car Hauler" },
  { value: "open_car_hauler", label: "Open Car Hauler" },
  { value: "hotshot_flatbed", label: "Hotshot Flatbed" },
  { value: "sprinter_van", label: "Sprinter Van" },
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

// ---------------------------------------------------------------------------
// Form state type
// ---------------------------------------------------------------------------
interface LoadForm {
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  rate: string;
  pickupAt: string;
  deliveryAt: string;
  equipment: Equipment;
  brokerName: string;
  brokerMc: string;
  notes: string;
}

function blankForm(): LoadForm {
  return {
    originCity: "",
    originState: "",
    destinationCity: "",
    destinationState: "",
    rate: "",
    pickupAt: "",
    deliveryAt: "",
    equipment: "hotshot_flatbed",
    brokerName: "",
    brokerMc: "",
    notes: "",
  };
}

// ---------------------------------------------------------------------------
// DriverLoadCreatePage
// ---------------------------------------------------------------------------

export default function DriverLoadCreatePage() {
  const { t } = useT();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<LoadForm>(blankForm);
  const set = (k: keyof LoadForm, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiJson<{ id: string }>("POST", "/api/me/loads", body),
    onSuccess: () => {
      toast({ title: t("driver.selfDispatch.success") });
      // Invalidate loads & dashboard so they refresh immediately
      queryClient.invalidateQueries({ queryKey: ["me", "loads"] });
      queryClient.invalidateQueries({ queryKey: ["me", "dashboard"] });
      setLocation("/loads");
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof Error ? err.message : t("driver.selfDispatch.error");
      toast({ title: t("driver.selfDispatch.error"), description: msg, variant: "destructive" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const rate = parseFloat(form.rate);
    if (!form.originCity || !form.originState) {
      toast({ title: "Origin city and state are required", variant: "destructive" });
      return;
    }
    if (!form.destinationCity || !form.destinationState) {
      toast({ title: "Destination city and state are required", variant: "destructive" });
      return;
    }
    if (!form.rate || isNaN(rate) || rate <= 0) {
      toast({ title: "Rate must be a positive number", variant: "destructive" });
      return;
    }
    if (!form.pickupAt || !form.deliveryAt) {
      toast({ title: "Pickup and delivery datetime are required", variant: "destructive" });
      return;
    }
    if (new Date(form.deliveryAt) <= new Date(form.pickupAt)) {
      toast({ title: "Delivery must be after pickup", variant: "destructive" });
      return;
    }

    mutation.mutate({
      originCity: form.originCity.trim(),
      originState: form.originState,
      destinationCity: form.destinationCity.trim(),
      destinationState: form.destinationState,
      rate,
      pickupAt: form.pickupAt,
      deliveryAt: form.deliveryAt,
      equipment: form.equipment,
      brokerName: form.brokerName.trim() || "Self-dispatch",
      brokerMc: form.brokerMc.trim(),
      notes: form.notes.trim() || undefined,
    });
  }

  return (
    <div className="space-y-5">
      {/* Back navigation */}
      <button
        type="button"
        onClick={() => setLocation("/loads")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("driver.selfDispatch.cancel")}
      </button>

      {/* Header */}
      <header className="flex items-start gap-3">
        <div className="rounded-md bg-primary/15 p-2">
          <Truck className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("driver.selfDispatch.title")}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("driver.selfDispatch.subtitle")}
          </p>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Origin */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("driver.selfDispatch.formLabels.origin")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.originCity")}</Label>
              <Input
                placeholder="e.g. Atlanta"
                value={form.originCity}
                onChange={(e) => set("originCity", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.originState")}</Label>
              <Select value={form.originState} onValueChange={(v) => set("originState", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((st) => (
                    <SelectItem key={st} value={st}>{st}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Destination */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("driver.selfDispatch.formLabels.destination")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.destinationCity")}</Label>
              <Input
                placeholder="e.g. Dallas"
                value={form.destinationCity}
                onChange={(e) => set("destinationCity", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.destinationState")}</Label>
              <Select value={form.destinationState} onValueChange={(v) => set("destinationState", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((st) => (
                    <SelectItem key={st} value={st}>{st}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Load details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Load details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.rate")}</Label>
              <Input
                type="number"
                min="1"
                step="0.01"
                placeholder="e.g. 1500"
                value={form.rate}
                onChange={(e) => set("rate", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.equipment")}</Label>
              <Select
                value={form.equipment}
                onValueChange={(v) => set("equipment", v as Equipment)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EQUIPMENT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.pickup")}</Label>
              <Input
                type="datetime-local"
                value={form.pickupAt}
                onChange={(e) => set("pickupAt", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.delivery")}</Label>
              <Input
                type="datetime-local"
                value={form.deliveryAt}
                onChange={(e) => set("deliveryAt", e.target.value)}
                required
              />
            </div>
          </CardContent>
        </Card>

        {/* Broker / shipper info (optional) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Broker / Shipper (optional)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.brokerName")}</Label>
              <Input
                placeholder="e.g. Direct shipper"
                value={form.brokerName}
                onChange={(e) => set("brokerName", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("driver.selfDispatch.formLabels.brokerMc")}</Label>
              <Input
                placeholder="MC-123456"
                value={form.brokerMc}
                onChange={(e) => set("brokerMc", e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("driver.selfDispatch.formLabels.notes")}</Label>
              <Input
                placeholder="Optional notes…"
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            type="submit"
            className="flex-1"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : t("driver.selfDispatch.submit")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setLocation("/loads")}
          >
            {t("driver.selfDispatch.cancel")}
          </Button>
        </div>
      </form>
    </div>
  );
}
