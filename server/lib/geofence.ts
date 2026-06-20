// ===========================================================================
// server/lib/geofence.ts — auto-checkin when driver enters pickup/delivery
// ===========================================================================
//
// After every GPS ping we call maybeAutoCheckin(userId, lat, lng). It looks
// up the driver's currently-booked loads and, for each, checks distance to
// the load's pickup_lat/lng and delivery_lat/lng. If within ARRIVAL_RADIUS_KM
// AND we don't already have a checkin of that kind for the load, we write
// one with kind=pickup_arrived/delivery_arrived and audit payload tagged
// `auto:geofence`.
//
// Why semi-auto (not full): we still want drivers to confirm 'loaded' and
// 'delivered' manually (they're business events that include paperwork).
// Arrival is just «I'm here» — perfect for automation.
// ---------------------------------------------------------------------------

import { storage } from "../storage";

/** 1.6 km \u2248 1 mile. Roomy enough for parking lots / truck stops. */
const ARRIVAL_RADIUS_KM = 1.6;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface AutoCheckinResult {
  loadId: string;
  kind: "pickup_arrived" | "delivery_arrived";
  distanceKm: number;
}

/**
 * Inspect the driver's booked loads and write any auto-arrival checkins
 * that should fire. Returns the list of checkins written (typically zero).
 * Never throws — geofence is best-effort; a bad row must not block the
 * GPS ping that triggered it.
 */
export function maybeAutoCheckin(
  userId: string,
  lat: number,
  lng: number,
): AutoCheckinResult[] {
  try {
    // Inspect ALL active booked loads, not the 20 most-recent of all loads —
    // an older still-open load would otherwise never get an auto check-in.
    const activeLoads = storage.listActiveBookedLoadsForDriver(userId);
    const written: AutoCheckinResult[] = [];

    for (const load of activeLoads) {
      const l = load as unknown as Record<string, unknown>;
      // Already filtered to booked + in-progress by the query, but keep the
      // bookedAt guard as a defensive no-op.
      if (!l.bookedAt) continue;

      const existing = storage.listCheckinsForLoad(load.id);
      const existingKinds = new Set(existing.map((c) => c.kind));

      // Pickup arrival.
      if (
        !existingKinds.has("pickup_arrived") &&
        typeof l.originLat === "number" &&
        typeof l.originLng === "number"
      ) {
        const d = haversineKm(lat, lng, l.originLat as number, l.originLng as number);
        if (d <= ARRIVAL_RADIUS_KM) {
          storage.insertLoadCheckin({
            loadId: load.id,
            driverUserId: userId,
            kind: "pickup_arrived",
            lat,
            lng,
            notes: `auto:geofence (${d.toFixed(2)}km from pickup)`,
          });
          storage.audit("load.auto_geofence_arrival", "load", load.id, {
            userId,
            kind: "pickup_arrived",
            distanceKm: d,
          });
          written.push({ loadId: load.id, kind: "pickup_arrived", distanceKm: d });
        }
      }

      // Delivery arrival.
      if (
        !existingKinds.has("delivery_arrived") &&
        // Require pickup_arrived to have happened first \u2014 prevents firing
        // delivery_arrival from the driver's home address during planning.
        existingKinds.has("pickup_arrived") &&
        typeof l.destinationLat === "number" &&
        typeof l.destinationLng === "number"
      ) {
        const d = haversineKm(
          lat,
          lng,
          l.destinationLat as number,
          l.destinationLng as number,
        );
        if (d <= ARRIVAL_RADIUS_KM) {
          storage.insertLoadCheckin({
            loadId: load.id,
            driverUserId: userId,
            kind: "delivery_arrived",
            lat,
            lng,
            notes: `auto:geofence (${d.toFixed(2)}km from delivery)`,
          });
          storage.audit("load.auto_geofence_arrival", "load", load.id, {
            userId,
            kind: "delivery_arrived",
            distanceKm: d,
          });
          written.push({ loadId: load.id, kind: "delivery_arrived", distanceKm: d });
        }
      }
    }
    return written;
  } catch (err) {
    console.error("[geofence] auto-checkin error:", err);
    return [];
  }
}
