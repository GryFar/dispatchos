// Adapter registry. Cron + admin UI both consume getAdapter(key).

import type { AdapterKey, BoardAdapter } from "./types";
import { mockAdapter } from "./mock";
import { sylectusEmailAdapter } from "./sylectus-email";
import { brokerEmailAdapters } from "./broker-email";
import { stubAdapters } from "./stubs";

// mockAdapter generates fabricated loads — it must NEVER be selectable in
// production, where it would pollute a live tenant's load board with fake
// brokers/rates/lanes. Register it only in non-prod, or when explicitly
// enabled via DISPATCHOS_ENABLE_MOCK_ADAPTER=true (e.g. a staging demo).
const allowMock =
  process.env.NODE_ENV !== "production" ||
  process.env.DISPATCHOS_ENABLE_MOCK_ADAPTER === "true";

const REAL: BoardAdapter[] = [
  ...(allowMock ? [mockAdapter] : []),
  sylectusEmailAdapter,
  ...brokerEmailAdapters,
];
const ALL: BoardAdapter[] = [...REAL, ...stubAdapters];

const byKey = new Map<AdapterKey, BoardAdapter>(ALL.map((a) => [a.key, a]));

export function getAdapter(key: string): BoardAdapter | undefined {
  return byKey.get(key as AdapterKey);
}

export function listAdapters(): Array<{
  key: AdapterKey;
  label: string;
  requiresCredentials: boolean;
  implemented: boolean;
}> {
  return ALL.map((a) => ({
    key: a.key,
    label: a.label,
    requiresCredentials: a.requiresCredentials,
    implemented: REAL.some((r) => r.key === a.key),
  }));
}

export { mockAdapter, sylectusEmailAdapter };
export type { BoardAdapter, AdapterKey, LoadSourceRow, NormalizedLoad, RawLoad } from "./types";
