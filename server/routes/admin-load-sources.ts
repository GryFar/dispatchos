// Admin CRUD for load_sources. Companion to /admin/load-sources UI Vlad is
// building. All endpoints are role-gated by the caller (registerAdminLoadSourcesRoutes).
//
// We never return plaintext credentials. UI displays `hasCredentials: bool`;
// to change creds the admin re-submits via PATCH which calls encryptSecret.

import type { Express, Request, Response as ExpressResponse } from "express";
import { storage } from "../storage";
import { getCurrentUser } from "../auth";
import {
  encryptCredentials,
  decryptCredentials,
  isPrimaryConfigured,
} from "../lib/crypto/keyring";
import {
  getAdapter,
  listAdapters,
} from "../lib/adapters";

interface CreateBody {
  clientId?: string;
  adapterKey?: string;
  label?: string;
  configJson?: Record<string, unknown>;
  credentials?: Record<string, string>;
  pollIntervalMin?: number;
  status?: string;
}

function redact(row: any) {
  if (!row) return row;
  const { credentialsEnc, credentialsIv, credentialsKeyId, ...safe } = row;
  return safe;
}

// Valid load_source.status values. Admins set active/paused; the system also
// uses needs_credentials/error. Anything else silently disables polling (the
// poller only selects status='active') with no feedback, so reject it.
const VALID_STATUSES = new Set(["active", "paused", "needs_credentials", "error"]);

// Mirror createLoadSource's clamp (storage.ts) so PATCH can't set a 0/negative
// interval that makes the source due on every poll tick and hammers an
// external board.
function clampPollInterval(n: number): number {
  return Math.max(1, Math.min(1440, Math.floor(n)));
}

export function registerAdminLoadSourcesRoutes(
  app: Express,
  requireAdmin: (req: Request, res: ExpressResponse, next: () => void) => void,
): void {
  // List available adapters for UI dropdown (Step 1 of wizard).
  app.get("/api/admin/load-sources/adapters", requireAdmin, (_req, res: ExpressResponse) => {
    res.json({ adapters: listAdapters() });
  });

  // List all configured load_sources.
  app.get("/api/admin/load-sources", requireAdmin, (req, res: ExpressResponse) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = storage.listLoadSources({ clientId, status });
    res.json({ loadSources: rows.map(redact) });
  });

  app.get("/api/admin/load-sources/:id", requireAdmin, (req, res: ExpressResponse) => {
    const id = String(req.params.id ?? "");
    const row = storage.getLoadSource(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    return res.json({ loadSource: redact(row) });
  });

  app.post("/api/admin/load-sources", requireAdmin, (req, res: ExpressResponse) => {
    const body = req.body as CreateBody;
    if (!body.clientId || !body.adapterKey || !body.label) {
      return res.status(400).json({ message: "clientId, adapterKey, label required" });
    }
    const adapter = getAdapter(body.adapterKey);
    if (!adapter) return res.status(400).json({ message: `Unknown adapter: ${body.adapterKey}` });
    // M3: don't create an orphan source pointed at a non-existent client.
    if (!storage.getClient(body.clientId)) {
      return res.status(400).json({ message: `Unknown client: ${body.clientId}` });
    }
    if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
      return res.status(400).json({ message: `Invalid status: ${body.status}` });
    }

    let encEnc: string | null = null;
    let encIv: string | null = null;
    let encKeyId: string | null = null;
    if (adapter.requiresCredentials) {
      if (!body.credentials) {
        return res.status(400).json({ message: `${adapter.label}: credentials required` });
      }
      if (!isPrimaryConfigured()) {
        return res.status(503).json({ message: "DISPATCHOS_KEYRING_PRIMARY not configured" });
      }
      const enc = encryptCredentials(body.credentials);
      encEnc = enc.ciphertext;
      encIv = enc.iv;
      encKeyId = enc.keyId;
    }

    const created = storage.createLoadSource({
      clientId: body.clientId,
      adapterKey: body.adapterKey,
      label: body.label,
      configJson: body.configJson ?? {},
      credentialsEnc: encEnc,
      credentialsIv: encIv,
      credentialsKeyId: encKeyId,
      pollIntervalMin: body.pollIntervalMin,
      status: body.status,
      createdBy: getCurrentUser(req)?.id,
    });
    storage.audit("load_source.created", "load_source", created!.id, {
      adapterKey: body.adapterKey,
      clientId: body.clientId,
      label: body.label,
    });
    return res.status(201).json({ loadSource: redact(created) });
  });

  app.patch("/api/admin/load-sources/:id", requireAdmin, (req, res: ExpressResponse) => {
    const id = String(req.params.id ?? "");
    const existing = storage.getLoadSource(id);
    if (!existing) return res.status(404).json({ message: "Not found" });

    const body = req.body as CreateBody & { rotateCredentials?: boolean };
    if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
      return res.status(400).json({ message: `Invalid status: ${body.status}` });
    }
    if (
      body.pollIntervalMin !== undefined &&
      (typeof body.pollIntervalMin !== "number" || !Number.isFinite(body.pollIntervalMin))
    ) {
      return res.status(400).json({ message: "pollIntervalMin must be a number" });
    }
    const patch: Record<string, unknown> = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.status !== undefined) patch.status = body.status;
    if (body.configJson !== undefined) patch.configJson = body.configJson;
    if (body.pollIntervalMin !== undefined) patch.pollIntervalMin = clampPollInterval(body.pollIntervalMin);

    if (body.credentials) {
      if (!isPrimaryConfigured()) {
        return res.status(503).json({ message: "DISPATCHOS_KEYRING_PRIMARY not configured" });
      }
      const enc = encryptCredentials(body.credentials);
      patch.credentialsEnc = enc.ciphertext;
      patch.credentialsIv = enc.iv;
      patch.credentialsKeyId = enc.keyId;
      // If admin reset status, clear it; else assume rotation fixes needs_credentials.
      if (existing.status === "needs_credentials" && body.status === undefined) {
        patch.status = "active";
      }
    }

    const updated = storage.updateLoadSource(id, patch);
    storage.audit("load_source.updated", "load_source", id, {
      fields: Object.keys(patch),
    });
    return res.json({ loadSource: redact(updated) });
  });

  // Soft delete = set status=paused. Hard delete blocked on purpose.
  app.delete("/api/admin/load-sources/:id", requireAdmin, (req, res: ExpressResponse) => {
    const id = String(req.params.id ?? "");
    const existing = storage.getLoadSource(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    storage.updateLoadSource(id, { status: "paused" });
    storage.audit("load_source.deleted", "load_source", id, {});
    return res.json({ ok: true });
  });

  // Test an adapter once — auth + fetch 1 item. Doesn't write anything.
  app.post("/api/admin/load-sources/:id/test", requireAdmin, async (req, res: ExpressResponse) => {
    const id = String(req.params.id ?? "");
    const row = storage.getLoadSource(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    const adapter = getAdapter(row.adapterKey);
    if (!adapter) return res.status(400).json({ message: `Unknown adapter: ${row.adapterKey}` });

    const t0 = Date.now();
    try {
      let credsPlain: Record<string, string> | undefined;
      if (adapter.requiresCredentials && row.credentialsEnc && row.credentialsIv && row.credentialsKeyId) {
        credsPlain = decryptCredentials({
          ciphertext: row.credentialsEnc,
          iv: row.credentialsIv,
          keyId: row.credentialsKeyId as "primary" | "secondary",
        });
      }
      const rowForAdapter = { ...row, credentialsPlaintext: credsPlain } as any;
      await adapter.authenticate(rowForAdapter);
      const sample = await adapter.fetchLoads(rowForAdapter, 1);
      const ms = Date.now() - t0;
      storage.audit("load_source.tested", "load_source", id, { ok: true, ms, sample: sample[0] ?? null });
      return res.json({ ok: true, latencyMs: ms, sample: sample[0] ?? null });
    } catch (err) {
      const ms = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      storage.audit("load_source.tested", "load_source", id, { ok: false, ms, error: msg });
      return res.status(200).json({ ok: false, latencyMs: ms, error: msg });
    }
  });
}
