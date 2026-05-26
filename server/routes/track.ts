// ===========================================================================
// server/routes/track.ts — public GPS ping ingest (no session, token-auth)
// ===========================================================================
//
// Endpoints are public (no admin gate) because they're hit by background
// GPS apps on drivers' phones. Auth is via the per-user tracking_token that
// admins generate from /admin/users/:id. Tokens are 32-byte hex strings so
// they're infeasible to brute-force, but we still rate-limit per-token to
// avoid log noise (Traccar Client can ping every 10 seconds on default).
//
// Two formats supported, matching the two free apps we recommend:
//
//   GET /api/track/osmand?id=<token>&lat=&lon=&timestamp=&speed=&bearing=&hdop=&batt=
//        Traccar Client (Android) and the OsmAnd protocol it emulates.
//        `lat`/`lon` are decimal degrees. `timestamp` is unix seconds.
//        Returns 200 with empty body — Traccar Client doesn't parse JSON.
//
//   POST /api/track/owntracks    Body: { _type:'location', tid, lat, lon, tst, ... }
//        Owntracks (iOS) HTTP transport. `tst` is unix seconds, `tid` is the
//        2-char tracker id but we read the token from the X-Limit-U header
//        OR from the `?token=` query param (Owntracks supports both).
//
// Both endpoints write to driver_location_pings and update the user's
// last_lat/last_lng cache. They never audit (too noisy).
// ---------------------------------------------------------------------------

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { maybeAutoCheckin } from "../lib/geofence";

function ah(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => next(error));
  };
}

/** Parse a unix-seconds or unix-millis timestamp into an ISO string. */
function parseTimestamp(raw: unknown): string {
  if (raw == null || raw === "") return new Date().toISOString();
  const n = Number(raw);
  if (!Number.isFinite(n)) return new Date().toISOString();
  // Heuristic: if 13+ digits, it's already millis; else seconds.
  const ms = n > 9_999_999_999 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function asNumber(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerTrackRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // GET /api/track/osmand — Traccar Client / OsmAnd protocol
  // -------------------------------------------------------------------------
  app.get(
    "/api/track/osmand",
    ah((req, res) => {
      const token = String(req.query.id ?? "");
      const user = token ? storage.getUserByTrackingToken(token) : undefined;
      if (!user) return res.status(401).end();

      const lat = asNumber(req.query.lat);
      const lng = asNumber(req.query.lon ?? req.query.lng);
      if (lat === undefined || lng === undefined) {
        return res.status(400).end();
      }
      // Sanity-clamp to valid earth coordinates so a misconfigured client
      // doesn't poison the DB.
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).end();
      }

      storage.recordLocationPing({
        userId: user.id,
        lat,
        lng,
        accuracyM: asNumber(req.query.accuracy ?? req.query.hdop),
        // Traccar reports speed in knots by default, but Android client sends m/s.
        // We accept either via `speed` (m/s) or `speed_kmh` if the user wired it.
        speedKmh: asNumber(req.query.speed_kmh)
          ?? (asNumber(req.query.speed) !== undefined ? asNumber(req.query.speed)! * 3.6 : undefined),
        headingDeg: asNumber(req.query.bearing ?? req.query.heading),
        batteryPct: asNumber(req.query.batt ?? req.query.battery),
        source: "osmand",
        capturedAt: parseTimestamp(req.query.timestamp),
      });
      // Auto-arrival checkins (Phase 7.3). Best-effort; never blocks the ping.
      maybeAutoCheckin(user.id, lat, lng);
      return res.status(200).end();
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/track/owntracks — Owntracks iOS HTTP transport
  // -------------------------------------------------------------------------
  app.post(
    "/api/track/owntracks",
    ah((req, res) => {
      // Owntracks supports auth via username (header X-Limit-U or query ?u=)
      // OR via password — we encode the tracking token as the username so the
      // device's "User ID" field doubles as our token.
      const token =
        (req.header("X-Limit-U") as string | undefined) ||
        String(req.query.u ?? req.query.token ?? "");
      const user = token ? storage.getUserByTrackingToken(token) : undefined;
      if (!user) return res.status(401).json({ message: "Unauthorized" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      // We only consume location reports. Owntracks also publishes
      // 'transition' and 'waypoint' events — ignore those here.
      const type = String(body._type ?? "");
      if (type !== "location") {
        // 200 so the device doesn't keep retrying a non-location event.
        return res.status(200).json([]);
      }

      const lat = asNumber(body.lat);
      const lng = asNumber(body.lon);
      if (lat === undefined || lng === undefined) {
        return res.status(400).json({ message: "lat/lon required" });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ message: "out-of-range coordinates" });
      }

      storage.recordLocationPing({
        userId: user.id,
        lat,
        lng,
        accuracyM: asNumber(body.acc),
        speedKmh: asNumber(body.vel),  // Owntracks reports km/h directly
        headingDeg: asNumber(body.cog),
        batteryPct: asNumber(body.batt),
        source: "owntracks",
        capturedAt: parseTimestamp(body.tst),
      });
      // Auto-arrival checkins (Phase 7.3). Best-effort; never blocks the ping.
      maybeAutoCheckin(user.id, lat, lng);

      // Owntracks expects a JSON array (it parses each element as a
      // server-issued command, empty array = no-op).
      return res.status(200).json([]);
    }),
  );
}
