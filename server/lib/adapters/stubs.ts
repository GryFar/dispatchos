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

function makeStub(key: AdapterKey, label: string, requiresCredentials: boolean): BoardAdapter {
  return {
    key,
    label,
    requiresCredentials,
    // Stubs have no real fetcher yet, so fail loudly at every entry point rather
    // than silently "succeeding". authenticate() throws so the "not implemented"
    // signal surfaces at the contract's validation step (types.ts:85), and
    // normalizeToLoad() throws instead of returning a zero-filled NormalizedLoad
    // (empty dedup key, $0 rate, 0,0 coords) — so a future half-built adapter
    // that gains fetchLoads but forgets to replace normalizeToLoad fails loudly
    // instead of upserting garbage loads.
    async authenticate() {
      throw new Error(`${label}: adapter not yet implemented`);
    },
    fetchLoads: notImplemented(label),
    normalizeToLoad: (_raw: RawLoad, _row: LoadSourceRow): NormalizedLoad => {
      throw new Error(`${label}: adapter not yet implemented`);
    },
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
