import { z } from "zod";

// ===========================================================================
// LOCATION + DRIVER + CLIENT (unchanged from v1.2.7)
// ===========================================================================

export const locationSourceSchema = z.enum([
  "live_gps",
  "telegram_live",
  "eld_tms",
  "manual_checkin",
  "projected_delivery",
  "last_known",
]);

export const clientStatusSchema = z.enum([
  "empty",
  "loaded",
  "at_pickup",
  "at_delivery",
  "delivered",
  "offline",
]);

export const equipmentSchema = z.enum([
  "enclosed_car_hauler",
  "open_car_hauler",
  "hotshot_flatbed",
  "sprinter_van",
]);

export const driverLocationSchema = z.object({
  city: z.string(),
  state: z.string(),
  lat: z.number(),
  lng: z.number(),
  source: locationSourceSchema,
  updatedAt: z.string(),
  status: clientStatusSchema,
  availableAt: z.string(),
  notes: z.string().optional(),
});

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  mc: z.string(),
  equipment: equipmentSchema,
  targetPpm: z.number(),
  minimumPpm: z.number(),
  mpg: z.number(),
  fuelPrice: z.number(),
  fixedCostPerMile: z.number(),
  preferredLanes: z.array(z.string()),
  avoidStates: z.array(z.string()),
  currentLocation: driverLocationSchema,
});

export const insertClientSchema = clientSchema.partial({ id: true }).extend({
  id: z.string().optional(),
});

// ===========================================================================
// LOAD (unchanged from v1.2.7)
// ===========================================================================

export const loadSchema = z.object({
  id: z.string(),
  source: z.string(),
  originCity: z.string(),
  originState: z.string(),
  originLat: z.number(),
  originLng: z.number(),
  destinationCity: z.string(),
  destinationState: z.string(),
  destinationLat: z.number(),
  destinationLng: z.number(),
  rate: z.number(),
  loadedMiles: z.number(),
  pickupAt: z.string(),
  deliveryAt: z.string(),
  equipment: equipmentSchema,
  brokerName: z.string(),
  brokerMc: z.string(),
  brokerScore: z.number(),
  fraudRisk: z.number(),
  marketQuality: z.number(),
  notes: z.string().optional(),
});

export const insertLoadSchema = loadSchema.partial({ id: true }).extend({
  id: z.string().optional(),
});

export const updateLocationSchema = driverLocationSchema.partial({
  updatedAt: true,
  availableAt: true,
}).extend({
  updatedAt: z.string().optional(),
  availableAt: z.string().optional(),
});

// ===========================================================================
// DOCUMENTS (unchanged from v1.2.7)
// ===========================================================================

export const documentTypeSchema = z.enum([
  "rate_confirmation",
  "bol",
  "pod",
  "coi",
  "w9",
  "authorization_letter",
  "other",
]);

export const documentStatusSchema = z.enum([
  "needed",
  "received",
  "submitted",
  "verified",
  "issue",
]);

export const documentSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  loadId: z.string().optional(),
  type: documentTypeSchema,
  status: documentStatusSchema,
  fileName: z.string(),
  storageUrl: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
});

export const insertDocumentSchema = documentSchema.partial({ id: true, createdAt: true }).extend({
  id: z.string().optional(),
  createdAt: z.string().optional(),
});

// ===========================================================================
// BROKER (unchanged from v1.2.7)
// ===========================================================================

export const brokerRecordSchema = z.object({
  id: z.string(),
  brokerMc: z.string(),
  brokerName: z.string(),
  authorityStatus: z.enum(["authorized", "not_authorized", "unknown", "needs_manual_check"]),
  authorityAgeMonths: z.number(),
  riskScore: z.number(),
  verdict: z.enum(["clean", "verify", "stop"]),
  flags: z.array(z.string()),
  checkedAt: z.string(),
});

export const brokerCheckSchema = z.object({
  brokerMc: z.string(),
  brokerName: z.string().optional(),
});

// ===========================================================================
// MISC INTAKE (unchanged from v1.2.7)
// ===========================================================================

export const csvImportSchema = z.object({
  csv: z.string().min(10),
});

export const telegramCommandSchema = z.object({
  clientId: z.string(),
  command: z.enum(["/loc", "/yes", "/no", "/nego"]),
  text: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export const emailIngestSchema = z.object({
  from: z.string(),
  subject: z.string(),
  body: z.string().min(5),
});

export const driveCreateSchema = z.object({
  clientId: z.string().optional(),
});

// ===========================================================================
// SCORING + DISPATCH BOARD (unchanged from v1.2.7)
// ===========================================================================

export const scoredLoadSchema = loadSchema.extend({
  deadheadMiles: z.number(),
  totalMiles: z.number(),
  deadheadRatio: z.number(),
  fuelCost: z.number(),
  fixedCost: z.number(),
  estimatedNet: z.number(),
  loadedPpm: z.number(),
  totalPpm: z.number(),
  netPpmTotal: z.number(),
  locationConfidence: z.enum(["high", "medium", "low"]),
  locationAgeMinutes: z.number(),
  pickupFeasibility: z.enum(["easy", "tight", "not_feasible"]),
  pickupBufferMinutes: z.number(),
  dispatchScore: z.number(),
  verdict: z.enum(["book", "negotiate", "skip"]),
  counterOffer: z.number().nullable(),
  rankReason: z.string(),
  warnings: z.array(z.string()),
});

export const dispatchBoardSchema = z.object({
  generatedAt: z.string(),
  selectedClient: clientSchema,
  clients: z.array(clientSchema),
  loads: z.array(scoredLoadSchema),
  topRecommendation: scoredLoadSchema,
  locationPolicy: z.object({
    highConfidenceMinutes: z.number(),
    mediumConfidenceMinutes: z.number(),
    staleRequiresCheckinMinutes: z.number(),
    command: z.string(),
  }),
});

// ===========================================================================
// USERS + ROLES (NEW in Phase 1)
// ===========================================================================
//
// Three roles: admin (owner LLC), dispatcher (operator), driver (client).
// Single users table. Single login (POST /api/auth/login) for all roles.
// After login, GET /api/me returns role + role-specific scoping data.
// ---------------------------------------------------------------------------

export const userRoleSchema = z.enum(["admin", "dispatcher", "driver"]);

export type UserRole = z.infer<typeof userRoleSchema>;

// What the client receives from GET /api/me and admin user-list endpoints.
// IMPORTANT: never expose passwordHash, passwordSalt, or totpSecret to client.
export const userPublicSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  fullName: z.string(),
  role: userRoleSchema,
  blocked: z.boolean(),
  twoFactorEnabled: z.boolean(),
  linkedClientId: z.string().optional(),                  // only for role=driver
  assignedClientIds: z.array(z.string()).optional(),      // only for role=dispatcher
  // Phase 4: additive optional fields. Phase 1 contract preserved — all
  // existing fields above are unchanged, these are strict-superset.
  phone: z.string().optional(),                           // any role; user-managed
  driverStatus: z.enum(["available", "on_route", "off_duty"]).optional(), // role=driver only
  createdAt: z.string(),
  updatedAt: z.string(),
  lastLoginAt: z.string().optional(),
});

// Input schema for admin creating a new user (no password — set via invite
// flow or admin-side reset). Used by POST /api/admin/users in Phase 3.
export const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  role: userRoleSchema,
  linkedClientId: z.string().optional(),
});

// Input schema for admin updating user properties.
// Used by PATCH /api/admin/users/:id in Phase 3.
export const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  role: userRoleSchema.optional(),
  blocked: z.boolean().optional(),
  linkedClientId: z.string().nullable().optional(),
});

// ===========================================================================
// AUTH FLOWS (NEW in Phase 1)
// ===========================================================================

export const loginSchema = z.object({
  // Email is the primary identifier. The legacy `username` field is accepted
  // as an alias for backward compatibility with the v1.2.7 owner setup flow.
  email: z.string().email().optional(),
  username: z.string().optional(),
  password: z.string().min(1),
  token: z.string().optional(),
}).refine((data) => Boolean(data.email || data.username), {
  message: "Either email or username is required",
  path: ["email"],
});

// Bootstrap = create the very first admin (formerly /api/auth/setup).
// Allowed only when the users table is empty.
export const bootstrapSchema = z.object({
  email: z.string().email().optional(),
  username: z.string().optional(),
  fullName: z.string().optional(),
  password: z.string().min(10),
}).refine((data) => Boolean(data.email || data.username), {
  message: "Either email or username is required",
  path: ["email"],
});

// Signup via invite code (Phase 3 wires this to /api/auth/signup; defined
// here so Claude Design and the second AI share the contract from day one).
export const signupSchema = z.object({
  inviteCode: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  password: z.string().min(10),
});

// ===========================================================================
// INVITES (NEW in Phase 1)
// ===========================================================================
//
// One-time, expiring codes generated by an admin to onboard dispatcher or
// driver. Optionally email-locked.
// ---------------------------------------------------------------------------

export const inviteSchema = z.object({
  code: z.string(),
  role: userRoleSchema,
  email: z.string().email().optional(),
  expiresAt: z.string(),
  consumedAt: z.string().optional(),
  consumedByUserId: z.string().optional(),
  createdAt: z.string(),
  createdByUserId: z.string(),
  // For driver invites: pre-link to a specific client record on consume.
  linkedClientId: z.string().optional(),
});

export const createInviteSchema = z.object({
  role: userRoleSchema,
  email: z.string().email().optional(),
  ttlHours: z.number().int().positive().max(24 * 30).optional(), // max 30d
  linkedClientId: z.string().optional(),
});

// ===========================================================================
// ASSIGNMENTS (NEW in Phase 1)
// ===========================================================================
//
// Many-to-many: a client (driver-as-client record) can be assigned to one or
// more dispatchers (24h rotation requires overlap). Soft-deleted via removedAt.
// ---------------------------------------------------------------------------

export const assignmentSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  dispatcherUserId: z.string(),
  createdAt: z.string(),
  createdByUserId: z.string(),
  removedAt: z.string().optional(),
  removedByUserId: z.string().optional(),
});

export const createAssignmentSchema = z.object({
  clientId: z.string(),
  dispatcherUserId: z.string(),
});

// ===========================================================================
// INVOICES (NEW in Phase 1)
// ===========================================================================
//
// One invoice per client per week. Formula: $150 flat + 3% of grossBooked.
// Status lifecycle: draft -> sent -> paid (or void).
// ---------------------------------------------------------------------------

export const invoiceStatusSchema = z.enum(["draft", "sent", "paid", "void"]);

export const invoiceSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  weekStart: z.string(),               // ISO date, Monday 00:00 client TZ
  weekEnd: z.string(),                 // ISO date, Sunday 23:59 client TZ
  flatFee: z.number(),                 // 150
  percentFee: z.number(),              // grossBooked * 0.03
  grossBooked: z.number(),             // sum of booked loads' rates that week
  totalDue: z.number(),                // flatFee + percentFee
  status: invoiceStatusSchema,
  generatedAt: z.string(),
  sentAt: z.string().optional(),
  paidAt: z.string().optional(),
  notes: z.string().optional(),
});

// ===========================================================================
// TYPE EXPORTS
// ===========================================================================

export type LocationSource = z.infer<typeof locationSourceSchema>;
export type ClientStatus = z.infer<typeof clientStatusSchema>;
export type Equipment = z.infer<typeof equipmentSchema>;
export type DriverLocation = z.infer<typeof driverLocationSchema>;
export type Client = z.infer<typeof clientSchema>;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Load = z.infer<typeof loadSchema>;
export type InsertLoad = z.infer<typeof insertLoadSchema>;
export type DocumentRecord = z.infer<typeof documentSchema>;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type BrokerRecord = z.infer<typeof brokerRecordSchema>;
export type ScoredLoad = z.infer<typeof scoredLoadSchema>;
export type DispatchBoard = z.infer<typeof dispatchBoardSchema>;

// Phase 1 additions
export type UserPublic = z.infer<typeof userPublicSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

// ===========================================================================
// PHASE 2 ADDITIONS (additive only — Phase 1 contracts untouched)
// ===========================================================================
//
// Added by Claude Design for Admin UI needs. ИИ-бэкендер opt-in: shapes
// должны быть реализованы в Phase 3 для соответствующих /api/admin/* endpoints.
// ---------------------------------------------------------------------------

/**
 * Paginated response wrapper. Returned by ALL /api/admin/* list endpoints.
 *
 * `nextCursor`: ISO timestamp of the LAST item on this page (used as
 *   `?cursor=` for the next request). `null` if this is the final page.
 * `total`: total items matching filters (без учёта limit/cursor). `null`
 *   allowed if count is expensive (UI will hide the counter).
 */
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number().nullable(),
  });

/** Generic pagination params for any list endpoint. */
export const paginationParamsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type PaginationParams = z.infer<typeof paginationParamsSchema>;

/** Filters for /api/admin/users (admin UI state). */
export const userListFiltersSchema = paginationParamsSchema.extend({
  q: z.string().optional(),
  role: userRoleSchema.optional(),
  blocked: z.boolean().optional(),
});
export type UserListFilters = z.infer<typeof userListFiltersSchema>;

/** Filters for /api/admin/invites. */
export const inviteListFiltersSchema = paginationParamsSchema.extend({
  status: z.enum(["active", "expired", "consumed", "all"]).optional(),
  role: userRoleSchema.optional(),
});
export type InviteListFilters = z.infer<typeof inviteListFiltersSchema>;

/** Filters for /api/admin/assignments. */
export const assignmentListFiltersSchema = paginationParamsSchema.extend({
  dispatcherId: z.string().optional(),
  clientId: z.string().optional(),
  includeRemoved: z.boolean().optional(),
});
export type AssignmentListFilters = z.infer<typeof assignmentListFiltersSchema>;

/** Filters for /api/admin/billing/invoices. */
export const invoiceListFiltersSchema = paginationParamsSchema.extend({
  clientId: z.string().optional(),
  status: invoiceStatusSchema.optional(),
  weekStart: z.string().optional(),
  weekEnd: z.string().optional(),
});
export type InvoiceListFilters = z.infer<typeof invoiceListFiltersSchema>;

/** Body for /api/admin/billing/preview and /api/admin/billing/generate. */
export const generateInvoiceSchema = z.object({
  clientId: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  status: z.enum(["draft", "sent"]).optional(),
});
export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;

/** Invoice preview response — includes per-load breakdown. id/status/generatedAt are null. */
export const invoicePreviewSchema = z.object({
  id: z.null(),
  clientId: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  flatFee: z.number(),
  percentFee: z.number(),
  grossBooked: z.number(),
  totalDue: z.number(),
  status: z.null(),
  generatedAt: z.null(),
  notes: z.string().optional(),
  breakdown: z.object({
    loadCount: z.number(),
    loads: z.array(z.object({
      loadId: z.string(),
      rate: z.number(),
      originCity: z.string(),
      destinationCity: z.string(),
      deliveredAt: z.string().optional(),
    })),
  }),
});
export type InvoicePreview = z.infer<typeof invoicePreviewSchema>;

/** Aggregate response for /api/admin/dashboard/stats. */
export const integrationHealthSchema = z.object({
  status: z.enum(["ok", "warn", "missing", "error"]),
  lastCheckedAt: z.string().nullable(),
  message: z.string().optional(),
});

export const dashboardStatsSchema = z.object({
  mrr: z.object({
    currentUsd: z.number(),
    projectedUsd: z.number().nullable(),
    activeClients: z.number(),
    trend: z.object({
      direction: z.enum(["up", "down", "flat"]),
      percent: z.number(),
    }).optional(),
  }),
  users: z.object({
    admins: z.number(),
    dispatchers: z.number(),
    drivers: z.number(),
    blocked: z.number(),
    lastSignupAt: z.string().nullable(),
  }),
  loads: z.object({
    weekCount: z.number(),
    weekGrossUsd: z.number(),
    byVerdict: z.object({
      book: z.number(),
      negotiate: z.number(),
      skip: z.number(),
    }),
  }),
  audit: z.object({
    eventsLast24h: z.number(),
    lastEventAt: z.string().nullable(),
    errorEventsLast24h: z.number(),
  }),
  integrations: z.record(z.string(), integrationHealthSchema),
  system: z.object({
    version: z.string(),
    uptimeSeconds: z.number(),
    dbSizeBytes: z.number().nullable(),
  }),
});
export type IntegrationHealth = z.infer<typeof integrationHealthSchema>;
export type DashboardStats = z.infer<typeof dashboardStatsSchema>;

/** Filters for GET /api/audit (extended endpoint). */
export const auditListFiltersSchema = paginationParamsSchema.extend({
  eventType: z.union([z.string(), z.array(z.string())]).optional(),
  entityType: z.string().optional(),
  actorId: z.string().optional(),
  entityId: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});
export type AuditListFilters = z.infer<typeof auditListFiltersSchema>;

/** Audit event shape, as returned by the extended /api/audit. */
export const auditEventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Login response shape (matches Phase 1 server). */
export const loginResponseSchema = z.object({
  ok: z.literal(true),
  role: userRoleSchema,
  redirect: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Signup response shape (Phase 3 server should match). */
export const signupResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: userRoleSchema,
  totpSecret: z.string().optional(),
  otpauthUrl: z.string().optional(),
  redirect: z.string(),
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;

// ===========================================================================
// PHASE 3 P2 ADDITIONS — load <-> client booking link
// ===========================================================================
//
// Billing needs to know "which loads were booked for which client during which
// week" (see admin-api-spec.md §4.1). Phase 1 loadSchema has neither field, so
// Phase 3 extends it with two OPTIONAL columns:
//
//   clientId  — string, the booking owner. Set by dispatcher (Phase 4) or the
//               admin via the future POST /api/loads/:id/book hook.
//   bookedAt  — "YYYY-MM-DD" date-only string. We intentionally drop the
//               clock + timezone to avoid coordination pain between admins in
//               FL, devs in Odessa, Canada, etc. If a per-second timestamp is
//               ever needed, add a second `bookedAtTs` field — don't repurpose
//               this one.
//
// Storage keeps two copies: the JSON payload (source of truth, backward-compat
// with v1.2.7 listLoads) AND dedicated SQLite columns + index, so billing can
// run an indexed SQL query rather than a full table scan.
// ---------------------------------------------------------------------------

/** YYYY-MM-DD validator. Reused for bookedAt and for weekStart/weekEnd. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

/**
 * Optional billing-link fields, additively applied to loadSchema / insertLoadSchema.
 * NOT included in the original loadSchema definition (Phase 1 contract) so that
 * existing v1.2.7 callers and seeds continue to validate.
 */
export const loadBookingFieldsSchema = z.object({
  clientId: z.string().optional(),
  bookedAt: dateOnlySchema.optional(),
});

/** loadSchema extended with the optional booking-link fields. */
export const loadWithBookingSchema = loadSchema.merge(loadBookingFieldsSchema);
export type LoadWithBooking = z.infer<typeof loadWithBookingSchema>;

/** insertLoadSchema extended likewise. POST /api/loads accepts the same body. */
export const insertLoadWithBookingSchema = insertLoadSchema.merge(loadBookingFieldsSchema);
export type InsertLoadWithBooking = z.infer<typeof insertLoadWithBookingSchema>;

// ===========================================================================
// PHASE 4 ADDITIONS — Driver portal (P0)
// ===========================================================================
//
// All schemas below are additive. Phase 1-3 types/shapes ABOVE are not edited
// (except userPublicSchema gaining two optional fields — strict superset).
//
// Conventions:
//   - driverStatus: column on users, controls dashboard status card colour and
//     dispatcher pipeline visibility ("off_duty" hides from auto-suggest).
//   - loadStatus: derived (not a column) from booking + delivery fields. We do
//     not store status on loads yet — Phase 1 contract is preserved. Used as
//     a query filter in /api/me/loads?status=available.
//   - driverId: optional column on loads, mirrored into loads.driver_id like
//     clientId/bookedAt did in P2. Set by dispatcher booking (P3) or seed.
// ---------------------------------------------------------------------------

/** Driver self-reported availability. Drives the dashboard status card. */
export const driverStatusSchema = z.enum(["available", "on_route", "off_duty"]);
export type DriverStatus = z.infer<typeof driverStatusSchema>;

/** Lifecycle status of a load. Computed from booking + dates (Phase 4 P0 has
 *  only "available" and "booked"; later phases add transit / delivery). */
export const loadStatusSchema = z.enum([
  "available",
  "booked",
  "in_transit",
  "at_delivery",
  "delivered",
  "cancelled",
]);
export type LoadStatus = z.infer<typeof loadStatusSchema>;

/** Body for POST /api/me/status. */
export const updateDriverStatusSchema = z.object({
  status: driverStatusSchema,
});
export type UpdateDriverStatusInput = z.infer<typeof updateDriverStatusSchema>;

/** Body for PATCH /api/me/profile. All fields optional; at least one must be
 *  provided. The driver cannot change email or role here. */
export const updateDriverProfileSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    phone: z.string().min(3).max(40).optional(),
  })
  .refine((v) => v.fullName !== undefined || v.phone !== undefined, {
    message: "At least one of fullName, phone must be provided",
  });
export type UpdateDriverProfileInput = z.infer<typeof updateDriverProfileSchema>;

/**
 * Optional driver-link field for loads. Like loadBookingFieldsSchema, this is
 * additive — POST /api/loads keeps accepting bodies without it.
 */
export const loadDriverFieldsSchema = z.object({
  driverId: z.string().optional(),
});

/** loadSchema + booking + driver. Full Phase 4 read shape. */
export const loadFullSchema = loadWithBookingSchema.merge(loadDriverFieldsSchema);
export type LoadFull = z.infer<typeof loadFullSchema>;

/** insertLoadSchema + booking + driver. POST /api/loads accepts this body. */
export const insertLoadFullSchema = insertLoadWithBookingSchema.merge(loadDriverFieldsSchema);
export type InsertLoadFull = z.infer<typeof insertLoadFullSchema>;

/**
 * Response shape for GET /api/me/dashboard. Aggregates everything the driver
 * home screen needs in a single round-trip — list / pagination endpoints are
 * available separately for deeper views.
 */
export const dashboardLoadStopSchema = z.object({
  time: z.string(),       // ISO datetime, copied from pickupAt / deliveryAt
  address: z.string(),    // "City, ST" — derived from load origin/destination
  contact: z.string().optional(),
});

export const driverDashboardSchema = z.object({
  driver: z.object({
    id: z.string(),
    fullName: z.string(),
    email: z.string().email(),
    phone: z.string().optional(),
    status: driverStatusSchema,
  }),
  currentLoad: loadFullSchema.nullable(),
  todayPickup: dashboardLoadStopSchema.nullable(),
  todayDelivery: dashboardLoadStopSchema.nullable(),
  /** Up to 3 most recent loads, newest first. P0: same shape as Load. */
  recentLoads: z.array(loadFullSchema),
  /** P0 stub — always false. P1 will read from a messages table. */
  hasUnreadMessages: z.boolean(),
  /** P0 stub — always []. P1 will read from documents.expires_at. */
  pendingDocs: z.array(
    z.object({
      type: z.string(),
      expiresAt: z.string().optional(),
    }),
  ),
});
export type DriverDashboard = z.infer<typeof driverDashboardSchema>;

/** Cursor-paginated response for GET /api/me/loads. */
export const meLoadsResponseSchema = z.object({
  items: z.array(loadFullSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number(),
});
export type MeLoadsResponse = z.infer<typeof meLoadsResponseSchema>;

// ===========================================================================
// PHASE 4 ADDITIONS — Signup leads (hybrid signup flow)
// ===========================================================================

export const signupLeadStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "spam",
]);
export type SignupLeadStatus = z.infer<typeof signupLeadStatusSchema>;

export const signupLeadSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  lang: z.string().nullable(),
  country: z.string().nullable(),
  userAgent: z.string().nullable(),
  referer: z.string().nullable(),
  status: signupLeadStatusSchema,
  approvedInviteCode: z.string().nullable(),
  reviewedByUserId: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
});
export type SignupLead = z.infer<typeof signupLeadSchema>;

export const subscribePublicSchema = z.object({
  email: z.string().email().max(254),
  lang: z.string().max(8).optional(),
  referer: z.string().max(500).optional(),
});

export const approveLeadSchema = z.object({
  role: z.enum(["driver", "dispatcher"]),
  linkedClientId: z.string().optional(),
});

export const rejectLeadSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const listLeadsQuerySchema = z.object({
  status: signupLeadStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

// ===========================================================================
// PHASE 4 ADDITIONS — Broker performance events (feeds AI brokers.ts)
// ===========================================================================

export const brokerEventTypeSchema = z.enum([
  "load_booked",
  "load_completed",
  "load_cancelled",
  "rate_honored",
  "rate_disputed",
  "paid_on_time",
  "paid_late",
  "non_payment",
  "ghosted",
  "double_broker_attempt",
  "fraud_report",
  "responsive",
  "rude_unprofessional",
  "positive_note",
  "negative_note",
]);
export type BrokerEventType = z.infer<typeof brokerEventTypeSchema>;

export const brokerEventSchema = z.object({
  id: z.string(),
  brokerMc: z.string(),
  eventType: brokerEventTypeSchema,
  loadId: z.string().nullable(),
  amountUsd: z.number().nullable(),
  notes: z.string().nullable(),
  loggedByUserId: z.string(),
  loggedAt: z.string(),
});
export type BrokerEvent = z.infer<typeof brokerEventSchema>;

export const insertBrokerEventSchema = z.object({
  brokerMc: z.string().min(1),
  eventType: brokerEventTypeSchema,
  loadId: z.string().optional(),
  amountUsd: z.number().optional(),
  notes: z.string().max(1000).optional(),
});
