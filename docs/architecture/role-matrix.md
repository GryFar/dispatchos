# Role & Permission Matrix

Three primary roles + one tenant boundary (carrier company / client).

## Roles

| Role | Who | Sees |
|---|---|---|
| **admin** | Owner / super admin | Everything: users, integrations, billing engine, all tenants, audit |
| **dispatcher** | Internal team member | Their assigned clients only: load pipeline, broker comms, approvals queue |
| **driver** | A specific carrier's driver | Only themselves: own loads, POD upload, check-ins, weekly report |
| **client** *(future)* | Carrier owner | Only their company: fleet, loads, billing, documents, approvals |

## Data Layers

| Layer | Visible to | Contents |
|---|---|---|
| **System** | admin only | Users, roles, integrations, automation rules, health, billing engine |
| **Ops** | dispatch team | Load pipeline, broker comms, client ops, internal notes, approvals queue |
| **Client** | specific carrier tenant | Their fleet, loads, docs, invoices, approvals, messages |

**Key rule:** the same object can have two projections.
A `Load` in the Ops layer carries AI score, internal margin, broker risk note, and next action.
The same `Load` in the Client layer shows only status, rate, pickup/drop, required approval, and documents.

## Endpoint Conventions

| Prefix | Required role | Owner |
|---|---|---|
| `/api/admin/*` | `admin` | Backend dev |
| `/api/dispatch/*` | `dispatcher` (or `admin`) | Backend dev (Phase 3) → Founder (Phase 5 portal) |
| `/api/me/*` | any authenticated | Backend dev (skeleton) → Founder (driver portal data) |
| `/api/client/*` *(future)* | `client` | Second AI |
| `/api/auth/*` | public | Backend dev |
| `/api/webhooks/*` | secret-token header | Backend dev |
| `/api/health` | public | Backend dev |

## Tenant Scope (shared endpoints)

For endpoints reachable by multiple roles (e.g., `GET /api/clients`, `GET /api/loads`):

- **admin** → sees everything
- **dispatcher** → only clients with `assignments.dispatcherId = self.id`
- **driver** → only loads where `loads.driverId = self.id`
- **client** → only loads/docs/invoices where `tenant_id = self.tenant_id`

Any endpoint that joins multiple tenants must call `enforceTenantScope(req)` before returning data.

## Entity Ownership

| Entity | Belongs to |
|---|---|
| Tenant | n/a (top-level) |
| User | n/a (system-level, but has `linkedClientId` for `driver` role) |
| Truck | Tenant |
| Driver | Tenant + User |
| Load | Tenant + Truck + Driver + Broker |
| LoadSuggestion | Tenant (suggested for) + Truck |
| ApprovalTask | Load or Document or Exception |
| Broker | shared (system-level, not per-tenant) |
| MessageThread | Load or Tenant |
| Document | Tenant + (optional Load / Driver / Truck) |
| Invoice | Tenant |
| AutomationRule | Tenant (some are global — flagged) |
| AuditEvent | attached to every critical action, with `actor_user_id` |

## Approval Flow (heart of the model)

The product's core value: **AI does ~90%, human confirms critical decisions.**

1. AI finds load opportunities for a specific truck profile (`dispatcher` sees)
2. System scores and fills risk/revenue/fit summary → Load Pipeline
3. Dispatcher reviews shortlist, edits/approves outbound communication
4. After negotiation, system creates `ApprovalTask` for the **client** if legal/business confirm is needed
5. Client sees clean card: route, rate, terms, deadline, approve/decline button
6. After approve → load → booked. Docs attached, statuses updated in both projections
7. After delivery → docs + accounting go to client portal; admin keeps audit, margin, performance history
