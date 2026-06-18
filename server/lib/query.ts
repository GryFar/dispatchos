// Shared query-param parsing helpers for route handlers.
//
// parseLimit centralises the "?limit=" handling. Several list endpoints did
// `req.query.limit ? Number(req.query.limit) : undefined`, which turns a
// non-numeric value (e.g. ?limit=abc) into NaN and passes it straight to the
// storage clamp: `Math.min(Math.max(NaN ?? 50, 1), 200)` stays NaN, so the SQL
// `LIMIT ?` binds NaN → SQLite treats it as no limit and returns every row
// (unbounded read / mild DoS). Returning undefined for any non-finite or
// non-positive value lets the storage layer apply its own default + clamp.

export function parseLimit(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
