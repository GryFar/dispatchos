// ===========================================================================
// shared/jurisdictions.ts — single source of truth for origin/destination
// jurisdictions (US states + Canadian provinces).
// ===========================================================================
//
// Every origin/destination picker used to hardcode its own 50-state `US_STATES`
// array (4 copies across the client). This is the one list they all import.
//
// The stored/searched value stays the 2-letter code (USPS state or Canada Post
// province) — the load pipeline, geocoder, IFTA and parser all key on that, so
// nothing downstream changes. `country` is metadata only: it lets dropdowns
// render US and Canada as SEPARATE groups instead of one jumbled list.
//
// US state codes and Canadian province codes do NOT collide (no province shares
// a USPS code), so a single flat code space is safe.
// ---------------------------------------------------------------------------

export type JurisdictionCountry = "US" | "CA";

export interface Jurisdiction {
  /** 2-letter code (USPS state / Canada Post province) — the stored value. */
  code: string;
  /** Full display name. */
  name: string;
  country: JurisdictionCountry;
}

export const JURISDICTIONS: readonly Jurisdiction[] = [
  // ---- United States (50 states + DC) ----
  { code: "AL", name: "Alabama", country: "US" },
  { code: "AK", name: "Alaska", country: "US" },
  { code: "AZ", name: "Arizona", country: "US" },
  { code: "AR", name: "Arkansas", country: "US" },
  { code: "CA", name: "California", country: "US" },
  { code: "CO", name: "Colorado", country: "US" },
  { code: "CT", name: "Connecticut", country: "US" },
  { code: "DE", name: "Delaware", country: "US" },
  { code: "FL", name: "Florida", country: "US" },
  { code: "GA", name: "Georgia", country: "US" },
  { code: "HI", name: "Hawaii", country: "US" },
  { code: "ID", name: "Idaho", country: "US" },
  { code: "IL", name: "Illinois", country: "US" },
  { code: "IN", name: "Indiana", country: "US" },
  { code: "IA", name: "Iowa", country: "US" },
  { code: "KS", name: "Kansas", country: "US" },
  { code: "KY", name: "Kentucky", country: "US" },
  { code: "LA", name: "Louisiana", country: "US" },
  { code: "ME", name: "Maine", country: "US" },
  { code: "MD", name: "Maryland", country: "US" },
  { code: "MA", name: "Massachusetts", country: "US" },
  { code: "MI", name: "Michigan", country: "US" },
  { code: "MN", name: "Minnesota", country: "US" },
  { code: "MS", name: "Mississippi", country: "US" },
  { code: "MO", name: "Missouri", country: "US" },
  { code: "MT", name: "Montana", country: "US" },
  { code: "NE", name: "Nebraska", country: "US" },
  { code: "NV", name: "Nevada", country: "US" },
  { code: "NH", name: "New Hampshire", country: "US" },
  { code: "NJ", name: "New Jersey", country: "US" },
  { code: "NM", name: "New Mexico", country: "US" },
  { code: "NY", name: "New York", country: "US" },
  { code: "NC", name: "North Carolina", country: "US" },
  { code: "ND", name: "North Dakota", country: "US" },
  { code: "OH", name: "Ohio", country: "US" },
  { code: "OK", name: "Oklahoma", country: "US" },
  { code: "OR", name: "Oregon", country: "US" },
  { code: "PA", name: "Pennsylvania", country: "US" },
  { code: "RI", name: "Rhode Island", country: "US" },
  { code: "SC", name: "South Carolina", country: "US" },
  { code: "SD", name: "South Dakota", country: "US" },
  { code: "TN", name: "Tennessee", country: "US" },
  { code: "TX", name: "Texas", country: "US" },
  { code: "UT", name: "Utah", country: "US" },
  { code: "VT", name: "Vermont", country: "US" },
  { code: "VA", name: "Virginia", country: "US" },
  { code: "WA", name: "Washington", country: "US" },
  { code: "WV", name: "West Virginia", country: "US" },
  { code: "WI", name: "Wisconsin", country: "US" },
  { code: "WY", name: "Wyoming", country: "US" },
  { code: "DC", name: "District of Columbia", country: "US" },

  // ---- Canada (10 provinces + 3 territories) ----
  { code: "AB", name: "Alberta", country: "CA" },
  { code: "BC", name: "British Columbia", country: "CA" },
  { code: "MB", name: "Manitoba", country: "CA" },
  { code: "NB", name: "New Brunswick", country: "CA" },
  { code: "NL", name: "Newfoundland and Labrador", country: "CA" },
  { code: "NS", name: "Nova Scotia", country: "CA" },
  { code: "NT", name: "Northwest Territories", country: "CA" },
  { code: "NU", name: "Nunavut", country: "CA" },
  { code: "ON", name: "Ontario", country: "CA" },
  { code: "PE", name: "Prince Edward Island", country: "CA" },
  { code: "QC", name: "Quebec", country: "CA" },
  { code: "SK", name: "Saskatchewan", country: "CA" },
  { code: "YT", name: "Yukon", country: "CA" },
];

/** All codes (US then CA), for callers that just need the flat list. */
export const JURISDICTION_CODES: readonly string[] = JURISDICTIONS.map((j) => j.code);

/** US state codes only. */
export const US_STATE_CODES: readonly string[] = JURISDICTIONS.filter(
  (j) => j.country === "US",
).map((j) => j.code);

/** Canadian province/territory codes only. */
export const CA_PROVINCE_CODES: readonly string[] = JURISDICTIONS.filter(
  (j) => j.country === "CA",
).map((j) => j.code);

/** Jurisdictions grouped by country — drives the two-section dropdown. */
export const JURISDICTIONS_BY_COUNTRY: {
  country: JurisdictionCountry;
  label: string;
  items: readonly Jurisdiction[];
}[] = [
  { country: "US", label: "United States", items: JURISDICTIONS.filter((j) => j.country === "US") },
  { country: "CA", label: "Canada", items: JURISDICTIONS.filter((j) => j.country === "CA") },
];

/** True if `code` is a known US state or Canadian province (case-insensitive). */
export function isKnownJurisdiction(code: string | null | undefined): boolean {
  if (!code) return false;
  const up = code.toUpperCase();
  return JURISDICTIONS.some((j) => j.code === up);
}
