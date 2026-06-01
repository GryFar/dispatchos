// US state (USPS code) → representative IANA timezone. For multi-zone states
// we pick the zone covering the largest share of the population/territory;
// this is a display heuristic for the driver "today" view, not legal HOS.
const STATE_TO_IANA: Record<string, string> = {
  AL: "America/Chicago",   AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago",   CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York",  DE: "America/New_York",  FL: "America/New_York",
  GA: "America/New_York",  HI: "Pacific/Honolulu",  ID: "America/Boise",
  IL: "America/Chicago",   IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago",   KY: "America/New_York",  LA: "America/Chicago",
  ME: "America/New_York",  MD: "America/New_York",  MA: "America/New_York",
  MI: "America/Detroit",   MN: "America/Chicago",   MS: "America/Chicago",
  MO: "America/Chicago",   MT: "America/Denver",    NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York",
  NM: "America/Denver",    NY: "America/New_York",  NC: "America/New_York",
  ND: "America/Chicago",   OH: "America/New_York",  OK: "America/Chicago",
  OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York",  SD: "America/Chicago",   TN: "America/Chicago",
  TX: "America/Chicago",   UT: "America/Denver",    VT: "America/New_York",
  VA: "America/New_York",  WA: "America/Los_Angeles", WV: "America/New_York",
  WI: "America/Chicago",   WY: "America/Denver",    DC: "America/New_York",
};

/**
 * Current calendar date (YYYY-MM-DD) in the timezone of `stateCode` (USPS
 * two-letter). Falls back to UTC when the state is unknown/empty — same
 * behaviour as before for non-US or missing data, so nothing regresses.
 */
export function todayInState(stateCode: string | undefined, now: Date = new Date()): string {
  const iana = stateCode ? STATE_TO_IANA[stateCode.toUpperCase()] : undefined;
  if (!iana) return now.toISOString().slice(0, 10);
  // en-CA gives YYYY-MM-DD; formatToParts avoids locale ordering surprises.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return y && m && d ? `${y}-${m}-${d}` : now.toISOString().slice(0, 10);
}