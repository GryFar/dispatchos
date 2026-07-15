// ===========================================================================
// server/lib/geo-coords.ts — offline city/state → lat/lng geocoding
// ===========================================================================
//
// Email-sourced loads arrive with only origin/destination CITY + STATE and were
// stored with lat/lng = 0,0. The scorer computes deadhead as the distance from
// the carrier to the origin coords — so (0,0) made every email load score as a
// ~7,000-mi deadhead off the coast of Africa, i.e. unrankable garbage. This
// resolves coordinates offline (no API key, no network) so those loads become
// scoreable: an exact match for ~40 major freight metros, else the state
// centroid (state-level accuracy is plenty for ranking deadhead), else null.

interface LatLng {
  lat: number;
  lng: number;
}

// Population/area-weighted state centroids (USPS code → lat,lng).
const STATE_CENTROID: Readonly<Record<string, LatLng>> = Object.freeze({
  AL: { lat: 32.8, lng: -86.8 }, AK: { lat: 64.0, lng: -152.0 }, AZ: { lat: 34.2, lng: -111.7 },
  AR: { lat: 34.9, lng: -92.4 }, CA: { lat: 37.2, lng: -119.3 }, CO: { lat: 39.0, lng: -105.5 },
  CT: { lat: 41.6, lng: -72.7 }, DE: { lat: 39.0, lng: -75.5 }, FL: { lat: 28.6, lng: -82.4 },
  GA: { lat: 32.6, lng: -83.4 }, HI: { lat: 20.3, lng: -156.4 }, ID: { lat: 44.2, lng: -114.5 },
  IL: { lat: 40.0, lng: -89.2 }, IN: { lat: 39.9, lng: -86.3 }, IA: { lat: 42.0, lng: -93.5 },
  KS: { lat: 38.5, lng: -98.4 }, KY: { lat: 37.5, lng: -85.3 }, LA: { lat: 31.0, lng: -92.0 },
  ME: { lat: 45.4, lng: -69.2 }, MD: { lat: 39.0, lng: -76.7 }, MA: { lat: 42.3, lng: -71.8 },
  MI: { lat: 44.3, lng: -85.4 }, MN: { lat: 46.3, lng: -94.3 }, MS: { lat: 32.7, lng: -89.7 },
  MO: { lat: 38.4, lng: -92.5 }, MT: { lat: 47.0, lng: -109.6 }, NE: { lat: 41.5, lng: -99.8 },
  NV: { lat: 39.3, lng: -116.6 }, NH: { lat: 43.7, lng: -71.6 }, NJ: { lat: 40.1, lng: -74.7 },
  NM: { lat: 34.4, lng: -106.1 }, NY: { lat: 42.9, lng: -75.5 }, NC: { lat: 35.5, lng: -79.4 },
  ND: { lat: 47.5, lng: -100.5 }, OH: { lat: 40.3, lng: -82.8 }, OK: { lat: 35.6, lng: -97.5 },
  OR: { lat: 44.0, lng: -120.5 }, PA: { lat: 40.9, lng: -77.8 }, RI: { lat: 41.7, lng: -71.6 },
  SC: { lat: 33.9, lng: -80.9 }, SD: { lat: 44.4, lng: -100.2 }, TN: { lat: 35.9, lng: -86.4 },
  TX: { lat: 31.5, lng: -99.3 }, UT: { lat: 39.3, lng: -111.7 }, VT: { lat: 44.1, lng: -72.7 },
  VA: { lat: 37.5, lng: -78.9 }, WA: { lat: 47.4, lng: -120.5 }, WV: { lat: 38.6, lng: -80.6 },
  WI: { lat: 44.6, lng: -89.9 }, WY: { lat: 43.0, lng: -107.5 }, DC: { lat: 38.9, lng: -77.0 },
  // Canada — province/territory centroids (freight-weighted toward the populated south).
  AB: { lat: 52.5, lng: -114.5 }, BC: { lat: 51.0, lng: -122.5 }, MB: { lat: 51.0, lng: -98.7 },
  NB: { lat: 46.5, lng: -66.5 }, NL: { lat: 48.5, lng: -56.0 }, NS: { lat: 45.0, lng: -63.0 },
  NT: { lat: 64.5, lng: -119.0 }, NU: { lat: 66.0, lng: -85.0 }, ON: { lat: 44.5, lng: -79.5 },
  PE: { lat: 46.4, lng: -63.2 }, QC: { lat: 46.5, lng: -72.5 }, SK: { lat: 52.0, lng: -106.0 },
  YT: { lat: 63.0, lng: -135.0 },
});

// Major US freight metros (key = "city|ST", lowercased city) → lat,lng.
const CITY_COORDS: Readonly<Record<string, LatLng>> = Object.freeze({
  "atlanta|GA": { lat: 33.75, lng: -84.39 }, "dallas|TX": { lat: 32.78, lng: -96.80 },
  "fort worth|TX": { lat: 32.76, lng: -97.33 }, "ft worth|TX": { lat: 32.76, lng: -97.33 },
  "houston|TX": { lat: 29.76, lng: -95.37 },
  "san antonio|TX": { lat: 29.42, lng: -98.49 }, "laredo|TX": { lat: 27.51, lng: -99.51 },
  "el paso|TX": { lat: 31.76, lng: -106.49 }, "chicago|IL": { lat: 41.88, lng: -87.63 },
  "los angeles|CA": { lat: 34.05, lng: -118.24 }, "long beach|CA": { lat: 33.77, lng: -118.19 },
  "fontana|CA": { lat: 34.10, lng: -117.46 }, "ontario|CA": { lat: 34.06, lng: -117.65 },
  "oakland|CA": { lat: 37.80, lng: -122.27 }, "newark|NJ": { lat: 40.74, lng: -74.17 },
  "new york|NY": { lat: 40.71, lng: -74.01 }, "miami|FL": { lat: 25.76, lng: -80.19 },
  "jacksonville|FL": { lat: 30.33, lng: -81.66 }, "orlando|FL": { lat: 28.54, lng: -81.38 },
  "tampa|FL": { lat: 27.95, lng: -82.46 }, "charlotte|NC": { lat: 35.23, lng: -80.84 },
  "greensboro|NC": { lat: 36.07, lng: -79.79 }, "memphis|TN": { lat: 35.15, lng: -90.05 },
  "nashville|TN": { lat: 36.16, lng: -86.78 }, "indianapolis|IN": { lat: 39.77, lng: -86.16 },
  "columbus|OH": { lat: 39.96, lng: -82.99 }, "cleveland|OH": { lat: 41.50, lng: -81.69 },
  "cincinnati|OH": { lat: 39.10, lng: -84.51 }, "detroit|MI": { lat: 42.33, lng: -83.05 },
  "kansas city|MO": { lat: 39.10, lng: -94.58 }, "st louis|MO": { lat: 38.63, lng: -90.20 },
  "saint louis|MO": { lat: 38.63, lng: -90.20 }, "denver|CO": { lat: 39.74, lng: -104.99 },
  "phoenix|AZ": { lat: 33.45, lng: -112.07 }, "seattle|WA": { lat: 47.61, lng: -122.33 },
  "portland|OR": { lat: 45.51, lng: -122.68 }, "salt lake city|UT": { lat: 40.76, lng: -111.89 },
  "las vegas|NV": { lat: 36.17, lng: -115.14 }, "reno|NV": { lat: 39.53, lng: -119.81 },
  "minneapolis|MN": { lat: 44.98, lng: -93.27 }, "oklahoma city|OK": { lat: 35.47, lng: -97.52 },
  "savannah|GA": { lat: 32.08, lng: -81.09 }, "baltimore|MD": { lat: 39.29, lng: -76.61 },
  "philadelphia|PA": { lat: 39.95, lng: -75.17 }, "pittsburgh|PA": { lat: 40.44, lng: -79.99 },
  "harrisburg|PA": { lat: 40.27, lng: -76.88 }, "boston|MA": { lat: 42.36, lng: -71.06 },
  "louisville|KY": { lat: 38.25, lng: -85.76 }, "birmingham|AL": { lat: 33.52, lng: -86.80 },
  // Canada — major freight / auto metros (Windsor = a key car-hauler corridor).
  "toronto|ON": { lat: 43.65, lng: -79.38 }, "mississauga|ON": { lat: 43.59, lng: -79.64 },
  "brampton|ON": { lat: 43.68, lng: -79.76 }, "hamilton|ON": { lat: 43.26, lng: -79.87 },
  "windsor|ON": { lat: 42.31, lng: -83.04 }, "ottawa|ON": { lat: 45.42, lng: -75.70 },
  "london|ON": { lat: 42.98, lng: -81.25 }, "montreal|QC": { lat: 45.50, lng: -73.57 },
  "quebec city|QC": { lat: 46.81, lng: -71.21 }, "quebec|QC": { lat: 46.81, lng: -71.21 },
  "vancouver|BC": { lat: 49.28, lng: -123.12 }, "surrey|BC": { lat: 49.19, lng: -122.85 },
  "calgary|AB": { lat: 51.05, lng: -114.07 }, "edmonton|AB": { lat: 53.55, lng: -113.49 },
  "winnipeg|MB": { lat: 49.90, lng: -97.14 }, "saskatoon|SK": { lat: 52.13, lng: -106.67 },
  "regina|SK": { lat: 50.45, lng: -104.62 }, "halifax|NS": { lat: 44.65, lng: -63.58 },
  "moncton|NB": { lat: 46.09, lng: -64.77 },
});

// Full state name (lowercased) → USPS code. Email-parsed lanes sometimes carry
// the spelled-out state ("Texas") instead of "TX"; without this they'd miss both
// the city key and STATE_CENTROID and return null, re-introducing the (0,0) bug.
const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze({
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
  // Canada — provinces + territories.
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", newfoundland: "NL", "nova scotia": "NS",
  "northwest territories": "NT", nunavut: "NU", ontario: "ON",
  "prince edward island": "PE", quebec: "QC", "québec": "QC", saskatchewan: "SK",
  yukon: "YT",
});

// Resolve a raw state token to its USPS code. Accepts a 2-letter code as-is, or
// maps a spelled-out state name; returns "" for anything else (caller -> null).
function normState(raw: string): string {
  const s = raw.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_NAME_TO_CODE[s.toLowerCase().replace(/\s+/g, " ")] ?? "";
}

function normCity(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve city + state (USPS) to coordinates, offline. Returns the city match
 * if known, else the state centroid, else null (unknown/blank state).
 */
export function geocodeCityState(
  city: string | null | undefined,
  state: string | null | undefined,
): LatLng | null {
  const st = normState(state ?? "");
  if (city) {
    const key = `${normCity(city)}|${st}`;
    const hit = CITY_COORDS[key];
    if (hit) return { ...hit };
  }
  const centroid = STATE_CENTROID[st];
  return centroid ? { ...centroid } : null;
}
