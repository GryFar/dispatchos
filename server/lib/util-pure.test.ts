// Pure utility tests: daysBetween, pickAlertThreshold, todayInState,
// isDisposableEmail. All deterministic, no DB.
// Run: npx tsx server/lib/util-pure.test.ts

import { daysBetween } from "./date-utils";
import { pickAlertThreshold } from "./alert-thresholds";
import { todayInState } from "./us-state-tz";
import { isDisposableEmail } from "./disposable-domains";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// --- daysBetween (UTC-midnight, DST-immune, time-of-day independent) --------
eq("same day -> 0", daysBetween("2026-06-15", "2026-06-15"), 0);
eq("next day -> 1", daysBetween("2026-06-15", "2026-06-16"), 1);
eq("backwards -> -1", daysBetween("2026-06-16", "2026-06-15"), -1);
eq("DST month span stays 30", daysBetween("2026-03-01", "2026-03-31"), 30);
eq("Jan->Feb -> 31", daysBetween("2026-01-01", "2026-02-01"), 31);
eq("time-of-day ignored", daysBetween("2026-06-15T23:00:00Z", "2026-06-16T01:00:00Z"), 1);
eq("unparseable -> 0", daysBetween("garbage", "2026-01-01"), 0);

// --- pickAlertThreshold (smallest milestone reached) -----------------------
const TH = [30, 14, 7, 1, 0, -1, -7];
eq("20 -> 30", pickAlertThreshold(20, TH), 30);
eq("14 -> 14", pickAlertThreshold(14, TH), 14);
eq("10 -> 14", pickAlertThreshold(10, TH), 14);
eq("7 -> 7", pickAlertThreshold(7, TH), 7);
eq("3 -> 7", pickAlertThreshold(3, TH), 7);
eq("0 -> 0", pickAlertThreshold(0, TH), 0);
eq("-3 -> -1", pickAlertThreshold(-3, TH), -1);
eq("above all -> null (too early)", pickAlertThreshold(40, TH), null);
eq("far past -> last milestone -7", pickAlertThreshold(-100, TH), -7);
eq("empty thresholds -> null", pickAlertThreshold(5, []), null);

// --- todayInState (tz applied; UTC fallback for unknown) -------------------
// 03:30Z on the 15th is still the 14th in US zones (UTC-4..-7 in summer).
const earlyUTC = new Date("2026-06-15T03:30:00Z");
eq("CA rolls back to prior day", todayInState("CA", earlyUTC), "2026-06-14");
eq("NY rolls back to prior day", todayInState("NY", earlyUTC), "2026-06-14");
eq("undefined -> UTC date", todayInState(undefined, earlyUTC), "2026-06-15");
eq("unknown state -> UTC date", todayInState("ZZ", earlyUTC), "2026-06-15");
// Midday UTC is same calendar day on the west coast.
eq("CA midday same day", todayInState("CA", new Date("2026-06-15T18:00:00Z")), "2026-06-15");

// --- isDisposableEmail -----------------------------------------------------
eq("mailinator -> true", isDisposableEmail("x@mailinator.com"), true);
eq("subdomain of disposable -> true", isDisposableEmail("a@sub.mailinator.com"), true);
eq("guerrillamail -> true", isDisposableEmail("a@guerrillamail.com"), true);
eq("gmail -> false", isDisposableEmail("user@gmail.com"), false);
eq("no @ -> false", isDisposableEmail("noatsign"), false);
eq("case-insensitive", isDisposableEmail("X@MAILINATOR.COM"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
