// Generic broker-email parser tests.
// Run: npx tsx server/lib/parsers/broker-email.test.ts
//
// Covers the common rate-con email shapes the email-forwarding adapters
// (RXO/TQL/Coyote/Echo/Landstar) rely on:
//   1. Plain-text "Field: value" body + subject lane.
//   2. HTML-table body (label/value rows).
//   3. Equipment-label -> Equipment enum mapping.
//   4. Lane fallback from the subject when the body omits origin/destination.
//   5. Broker MC extraction, money/miles/date parsing, dedup reference.
//
// Fixtures are realistic but synthetic; the first real forwarded email from a
// broker may need an extra field alias in parseBrokerEmail's get(...) lists.

import { parseBrokerEmail, mapEquipment } from "./broker-email";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  assert(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// 1. Plain-text "Field: value" body (RXO-style offer)
// ---------------------------------------------------------------------------
{
  const r = parseBrokerEmail({
    from: "loadoffers@rxo.com",
    subject: "Load Available - Dallas, TX to Atlanta, GA - $2,450",
    body: [
      "Origin: Dallas, TX 75201",
      "Destination: Atlanta, GA 30303",
      "Pickup: 06/20/2026 08:00",
      "Delivery: 06/21/2026 17:00",
      "Miles: 781",
      "Equipment: Enclosed car hauler",
      "Rate: $2,450",
      "Weight: 9,000 lbs",
      "Reference: RXO-558213",
      "Broker: RXO Logistics (MC# 1234567)",
    ].join("\n"),
  });
  assert("rxo: matched", r.matched);
  eq("rxo: origin city", r.origin?.city, "Dallas");
  eq("rxo: origin state", r.origin?.state, "TX");
  eq("rxo: dest city", r.destination?.city, "Atlanta");
  eq("rxo: dest state", r.destination?.state, "GA");
  eq("rxo: rate", r.rate, 2450);
  eq("rxo: miles", r.miles, 781);
  eq("rxo: weight", r.weightLbs, 9000);
  eq("rxo: equipment mapped", r.equipment, "enclosed_car_hauler");
  eq("rxo: reference", r.reference, "RXO-558213");
  eq("rxo: broker mc", r.broker?.mcNumber, "1234567");
  assert("rxo: pickup is ISO", /^2026-06-20T/.test(r.pickupAt ?? ""), r.pickupAt);
  assert("rxo: delivery is ISO", /^2026-06-21T/.test(r.deliveryAt ?? ""), r.deliveryAt);
}

// ---------------------------------------------------------------------------
// 2. HTML-table body (Coyote-style), lane only in body
// ---------------------------------------------------------------------------
{
  const r = parseBrokerEmail({
    from: "noreply@coyote.com",
    subject: "New covered load opportunity",
    body: `<html><body><table>
      <tr><td>Pickup</td><td>Phoenix, AZ</td></tr>
      <tr><td>Delivery</td><td>Denver, CO</td></tr>
      <tr><td>Total Miles</td><td>862</td></tr>
      <tr><td>Trailer</td><td>Open car hauler (7 car)</td></tr>
      <tr><td>Total Pay</td><td>$1,975.00</td></tr>
      <tr><td>Load #</td><td>CYT9981</td></tr>
    </table></body></html>`,
  });
  assert("coyote: matched", r.matched);
  eq("coyote: origin city", r.origin?.city, "Phoenix");
  eq("coyote: dest state", r.destination?.state, "CO");
  eq("coyote: miles", r.miles, 862);
  eq("coyote: rate from total pay", r.rate, 1975);
  eq("coyote: equipment open", r.equipment, "open_car_hauler");
  eq("coyote: reference from load#", r.reference, "CYT9981");
}

// ---------------------------------------------------------------------------
// 3. Lane only in subject (body lacks origin/destination)
// ---------------------------------------------------------------------------
{
  const r = parseBrokerEmail({
    from: "carrier@tql.com",
    subject: "Miami, FL -> Charlotte, NC | $1,650",
    body: ["Equipment: Hotshot flatbed", "Miles: 736", "Ref: TQL-44120"].join("\n"),
  });
  assert("tql: matched via subject lane", r.matched);
  eq("tql: origin from subject", r.origin?.city, "Miami");
  eq("tql: dest from subject", r.destination?.city, "Charlotte");
  eq("tql: rate from subject", r.rate, 1650);
  eq("tql: equipment hotshot", r.equipment, "hotshot_flatbed");
  eq("tql: reference", r.reference, "TQL-44120");
}

// ---------------------------------------------------------------------------
// 4. Equipment mapping table
// ---------------------------------------------------------------------------
{
  eq("equip: enclosed", mapEquipment("Enclosed"), "enclosed_car_hauler");
  eq("equip: open carrier", mapEquipment("Open carrier"), "open_car_hauler");
  eq("equip: 9 car", mapEquipment("9 car"), "open_car_hauler");
  eq("equip: flatbed", mapEquipment("Flatbed"), "hotshot_flatbed");
  eq("equip: hotshot", mapEquipment("Hot Shot"), "hotshot_flatbed");
  eq("equip: step deck", mapEquipment("Step Deck"), "hotshot_flatbed");
  eq("equip: sprinter", mapEquipment("Sprinter Van"), "sprinter_van");
  eq("equip: cargo van", mapEquipment("Cargo van"), "sprinter_van");
  eq("equip: unknown -> undefined", mapEquipment("Reefer 53ft"), undefined);
  eq("equip: empty -> undefined", mapEquipment(""), undefined);
}

// ---------------------------------------------------------------------------
// 5. Non-load email does not falsely match
// ---------------------------------------------------------------------------
{
  const r = parseBrokerEmail({
    from: "marketing@echo.com",
    subject: "Your weekly Echo newsletter",
    body: "Thanks for being a partner. Check out our blog for market insights.",
  });
  assert("noise: not matched", !r.matched);
  eq("noise: no origin", r.origin, undefined);
}

// ---------------------------------------------------------------------------
// 6. Bare MC number field + USD-prefixed rate (Landstar-style)
// ---------------------------------------------------------------------------
{
  const r = parseBrokerEmail({
    from: "agent@landstar.com",
    subject: "Load offer",
    body: [
      "From: Houston, TX",
      "To: New Orleans, LA",
      "Miles: 348",
      "Linehaul: USD 1,200.00",
      "MC: 123456",
      "Equipment: Open car hauler",
    ].join("\n"),
  });
  assert("landstar: matched", r.matched);
  eq("landstar: rate", r.rate, 1200);
  eq("landstar: bare mc", r.broker?.mcNumber, "123456");
  eq("landstar: origin", r.origin?.city, "Houston");
  eq("landstar: dest state", r.destination?.state, "LA");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
