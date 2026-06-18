// Stub adapters — surface in the UI dropdown so dispatchers can see what's
// available, but throw "not implemented" if they try to activate one before
// we've shipped the real fetcher. Each stub knows its config shape so the
// admin wizard can render the form correctly.

import type {
  AdapterKey,
  BoardAdapter,
  LoadSourceRow,
  NormalizedLoad,
  RawLoad,
} from "./types";

function notImplemented(label: string): BoardAdapter["fetchLoads"] {
  return async () => {
    throw new Error(`${label}: adapter not yet implemented`);
  };
}

function emptyNormalize(row: LoadSourceRow): NormalizedLoad {
  return {
    sourceId: row.id,
    sourceExternalId: "",
    clientId: row.clientId,
    source: row.adapterKey,
    originCity: "",
    originState: "",
    originLat: 0,
    originLng: 0,
    destinationCity: "",
    destinationState: "",
    destinationLat: 0,
    destinationLng: 0,
    rate: 0,
    loadedMiles: 0,
    pickupAt: "",
    deliveryAt: "",
    equipment: "sprinter_van",
    brokerName: "",
    brokerMc: "",
  };
}

function makeStub(key: AdapterKey, label: string, requiresCredentials: boolean): BoardAdapter {
  return {
    key,
    label,
    requiresCredentials,
    async authenticate() {},
    fetchLoads: notImplemented(label),
    normalizeToLoad: (_raw: RawLoad, row: LoadSourceRow) => emptyNormalize(row),
  };
}

// Email-forwarding brokers (rxo/tql/coyote/echo/landstar) are now REAL — see
// adapters/broker-email.ts. These remaining stubs need a scraper / REST creds
// and a real fetcher before they can be activated.
export const stubAdapters: BoardAdapter[] = [
  makeStub("super_dispatch",  "SuperDispatch (Playwright)",     true),
  makeStub("one23_loadboard", "123Loadboard (REST API)",        true),
  makeStub("dat_scraper",     "DAT One (scraper)",              true),
  makeStub("chr_navisphere",  "C.H. Robinson Navisphere",       true),
];
