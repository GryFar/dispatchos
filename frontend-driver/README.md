# Driver Portal Frontend

**Owner:** Founder (Perplexity Computer)
**Phase:** Waiting for `backend/` baseline + Phase 1 (roles)

## Purpose

The simplest portal of the four. Used by a single driver, often while in their truck.

## Design Principles

- **Minimal UI** — driver may be running this on a phone while pulled over. Few buttons, big tap targets.
- **Always works offline-ish** — submit POD photos even with bad signal; retry in background.
- **No internal numbers** — driver sees own loads, own earnings if shared, own profile. Nothing else.

## Scope

A driver sees:
- Today's assigned load(s)
- Pickup / delivery address with one-tap map link
- Upload BOL photo at pickup
- Upload POD photo at delivery
- Check-in button (location + status)
- Weekly summary (their loads, their gross)
- Profile (CDL expiry, medical, contact)

A driver does **not** see:
- Other drivers
- Margin or commission numbers
- Broker risk notes
- Load pipeline / suggested loads
- Approvals (those go to the owner/dispatcher)

## API Surface

All endpoints under `/api/me/*` (scoped to `self.user_id`).

## Status

⏸ Blocked on Phase 1, same as dispatcher portal.
