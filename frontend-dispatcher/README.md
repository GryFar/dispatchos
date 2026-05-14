# Dispatcher Portal Frontend

**Owner:** Founder (Perplexity Computer)
**Phase:** Waiting for `backend/` baseline + Phase 1 (roles)

## Purpose

Internal workspace for the dispatch team. **Not** for clients, **not** for drivers.

## Scope

Per role matrix (see `docs/architecture/role-matrix.md`), this portal serves users with `role = "dispatcher"`.
A dispatcher sees:
- Only clients with active `assignments.dispatcherId = self.id`
- Load pipeline (suggested → in negotiation → pending approval → sent → booked)
- Broker communication center
- Approval queue (their actions only)
- Documents linked to their clients/loads

A dispatcher does **not** see:
- Other dispatchers' clients
- Admin settings, billing engine, system audit
- Internal margin numbers across the company

## Stack (planned, aligned with admin portal)

To be confirmed once Claude Design ships the design tokens. Likely:
- Vite + React + TypeScript
- wouter for routing
- TanStack Query for API calls
- shadcn/ui components (Tailwind under the hood)
- Types pulled from `backend/shared/schema.ts`

## Status

⏸ **Blocked.** Waiting on:
1. Vlad to push `backend/` baseline
2. Vlad to ship Phase 1 (`shared/schema.ts` with roles, `/api/me`)
3. Claude Design to ship design tokens (Phase 2 day 1)

Once unblocked, Founder will scaffold the project.
