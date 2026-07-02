// Unit tests for the cron auth gate (requireCronSecret / timingSafeEqual).
// Run: npx tsx server/routes/cron.test.ts
//
// requireCronSecret guards ~9 unauthenticated cron endpoints (rescore,
// run-load-sources, pickup-reminders, check-insurance, check-trial-expiry,
// check-renewals, purge-old-data, refresh-fuel, refresh-gasbuddy, backup).
// The lib jobs behind it are tested elsewhere, but the gate itself — 503 when
// the secret is unset, 401 on mismatch, the constant-time length short-circuit,
// and pass-through on an exact match — was untested. This covers it directly
// against mock req/res so a regression that opens these endpoints is caught.

import type { Request, Response } from "express";
import { requireCronSecret, timingSafeEqual } from "./cron";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}

// Minimal Response stub capturing the last status() + json() call.
function mockRes(): Response & { _status: number | null; _body: unknown } {
  const res = {
    _status: null as number | null,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number | null; _body: unknown };
}

function mockReq(secret: string | string[] | undefined): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (secret !== undefined) headers["x-cron-secret"] = secret;
  return { headers } as unknown as Request;
}

const ORIGINAL = process.env.DISPATCHOS_CRON_SECRET;

console.log("requireCronSecret — cron auth gate");

// 1. Secret not configured → 503, gate denies.
delete process.env.DISPATCHOS_CRON_SECRET;
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq("anything"), res);
  assert(ok === false, "no DISPATCHOS_CRON_SECRET → denied");
  assert(res._status === 503, "no DISPATCHOS_CRON_SECRET → 503");
}

// 2. Configured but no header provided → 401, denied.
process.env.DISPATCHOS_CRON_SECRET = "s3cr3t-value";
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq(undefined), res);
  assert(ok === false, "missing header → denied");
  assert(res._status === 401, "missing header → 401");
}

// 3. Wrong secret (same length) → 401, denied.
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq("WRONG-value!!"), res);
  assert(ok === false, "wrong secret (same length) → denied");
  assert(res._status === 401, "wrong secret → 401");
}

// 4. Wrong secret (different length) → 401, denied (length short-circuit).
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq("short"), res);
  assert(ok === false, "wrong secret (different length) → denied");
  assert(res._status === 401, "length-mismatch secret → 401");
}

// 5. Array-valued header (duplicated header) uses the first element; a wrong
//    first element is denied.
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq(["nope-wrong-12", "s3cr3t-value"]), res);
  assert(ok === false, "array header, wrong first element → denied");
  assert(res._status === 401, "array header, wrong first element → 401");
}

// 6. Exact match → pass-through (returns true, no status set).
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq("s3cr3t-value"), res);
  assert(ok === true, "exact secret → pass-through");
  assert(res._status === null, "exact secret → no error response written");
}

// 7. Array header whose first element matches → pass-through.
{
  const res = mockRes();
  const ok = requireCronSecret(mockReq(["s3cr3t-value", "ignored"]), res);
  assert(ok === true, "array header, matching first element → pass-through");
}

console.log("\ntimingSafeEqual — constant-time compare");
assert(timingSafeEqual("abc", "abc") === true, "equal strings → true");
assert(timingSafeEqual("abc", "abd") === false, "same-length different → false");
assert(timingSafeEqual("abc", "abcd") === false, "different length → false");
assert(timingSafeEqual("", "") === true, "empty vs empty → true");

// Restore env so importing modules / subsequent runs see the original value.
if (ORIGINAL === undefined) delete process.env.DISPATCHOS_CRON_SECRET;
else process.env.DISPATCHOS_CRON_SECRET = ORIGINAL;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
