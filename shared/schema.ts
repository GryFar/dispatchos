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
  // Henry QA Bug #6+7 — contact person. All optional; set via admin client-detail.
  // Display pattern: "TRUCKING — John Smith" via formatClientDisplay() in shared/format-client.ts.
  contactPersonName: z.string().optional(),
  contactPersonEmail: z.string().email().optional(),
  contactPersonPhone: z.string().optional(),
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
  // Phase 5 smart-matching: optional hard-filter and economics inputs.
  // All optional so existing test fixtures keep validating. Defaults
  // applied in scoreLoadForClient when missing.
  equipmentTypes: z.array(equipmentSchema).optional(),  // accept multi-trailer fleets
  maxGvwLbs: z.number().optional(),                     // truck/trailer combined cap
  payCentsPerMile: z.number().optional(),               // driver pay model: flat cpm
  payPctOfGross: z.number().optional(),                 // driver pay model: % of gross
  blockedBrokers: z.array(z.string()).optional(),       // MC# strings to reject outright
  tollsCostPerMile: z.number().optional(),              // default 0.05 if absent
  wearCostPerMile: z.number().optional(),               // default 0.15 if absent
  hoursAvailable: z.number().optional(),                // HOS hours left, used to reject too-long loads
  fuelTankGallons: z.number().optional(),               // for future range planning
  avgMpg: z.number().optional(),                        // carrier avg miles/gallon, fuel cost + overpay calc
  scoreWeights: z.object({                              // per-client tuned weights
    ppm: z.number().optional(),
    deadhead: z.number().optional(),
    feasibility: z.number().optional(),
    broker: z.number().optional(),
    lane: z.number().optional(),
    location: z.number().optional(),
  }).optional(),
  // Phase 7.2 — insurance certificate expiry tracking. ISO dates (yyyy-MM-dd).
  // The monitor cron fires alerts at 14/7/3/1 days before any of these.
  cargoInsuranceExpiresAt: z.string().optional(),       // «Cargo insurance» expiry
  autoLiabilityExpiresAt: z.string().optional(),        // «Auto liability» expiry
  generalLiabilityExpiresAt: z.string().optional(),     // «General liability» expiry (optional)
  // Killer feature #5 — UCR / IRP renewal calendar. Optional ISO dates.
  ucrExpiresAt: z.string().optional(),                  // UCR annual filing due date
  ucrBaseState: z.string().optional(),                  // 2-letter US state
  irpExpiresAt: z.string().optional(),                  // IRP apportioned plates anniversary
  irpBaseJurisdiction: z.string().optional(),           // 2-letter base jurisdiction
  // Killer feature #4 — detention billing overrides.
  detentionFreeHours: z.number().min(0).max(24).optional(),
  detentionRatePerHourCents: z.number().int().min(0).max(50_000).optional(),
  // ==========================================================================
  // Onboarding + billing tier (per user request 2026-05-26).
  // Персона определяет ветку онбординга и default tier.
  // ==========================================================================
  persona: z.enum(["owner_operator", "fleet", "enterprise"]).optional(),
  onboardingCompletedAt: z.string().optional(),
  /** "trial" | "oo_basic" | "oo_premium" | "fleet_starter" | "fleet_growth" | "fleet_scale" | "enterprise" */
  planTier: z.string().optional(),
  // Soft-delete marker (mirrors the users pattern). Set to an ISO timestamp
  // when an admin archives the client; the row + payload are kept for FK
  // integrity (loads.clientId, assignments, driver.linkedClientId) and billing
  // history. listClients() hides archived clients; getClient() still resolves
  // them by id so Stripe webhooks / audit can reference them.
  deletedAt: z.string().nullable().optional(),
  trialEndsAt: z.string().optional(),
  billingStatus: z.enum(["trial", "active", "past_due", "canceled", "expired"]).optional(),
  stripeCustomerId: z.string().optional(),
  stripeSubscriptionId: z.string().optional(),
  /** Active seat counts — enforced by tier limits in feature gates. */
  driverSeatCount: z.number().int().min(0).optional(),
  dispatcherSeatCount: z.number().int().min(0).optional(),
});

// Onboarding step machine — server-tracked progress so the wizard can
// resume on reload, switch device, or return after a TG bot link.
export const onboardingProgressSchema = z.object({
  userId: z.string(),
  step: z.number().int().min(0).max(10),
  data: z.record(z.string(), z.unknown()),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>;

export const ONBOARDING_STEPS = [
  "persona",
  "credentials",
  "company",
  "documents",
  "plan",
  "telegram",
  "done",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const updateOnboardingProgressSchema = z.object({
  step: z.number().int().min(0).max(10),
  data: z.record(z.string(), z.unknown()).optional(),
  /** Mark the user as completed (transitions billing to trial). */
  completed: z.boolean().optional(),
});
export type UpdateOnboardingProgressInput = z.infer<
  typeof updateOnboardingProgressSchema
>;

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
  /** First-class driver assignment. Replaces the additive loadDriverFieldsSchema addon. */
  driverId: z.string().optional(),
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
  // Phase 7 — online presence. Set by middleware on every authenticated
  // /api request (throttled 30s/user). Frontend computes online status as
  // (now - lastSeenAt) < 2 minutes.
  lastSeenAt: z.string().optional(),
  // Soft-delete marker. null/absent = active. Set = user was removed by an
  // admin (distinct from `blocked`, which is a reversible suspension). The
  // row is kept for FK integrity (loads.driverId, audit_events, assignments).
  deletedAt: z.string().nullable().optional(),
  // i18n — last UI language the user picked. Synced across devices via
  // PATCH /api/me/preferences. Frontend falls back to localStorage when
  // this is null (e.g. legacy users who never picked).
  preferredLang: z.enum(["ru", "en", "es", "fr"]).nullable().optional(),
  // Henry QA Bug #5 — truck unit number. Only meaningful for role=driver;
  // dispatchers/admins can set it on driver detail pages. Null = not assigned.
  unitNumber: z.string().nullable().optional(),
  // feat/twilio-verify-phone-email — verification timestamps.
  phoneVerifiedAt: z.string().nullable().optional(),
  emailVerifiedAt: z.string().nullable().optional(),
});

// Body schema for PATCH /api/me/preferences— currently only carries
// preferredLang but kept open for future per-user prefs (theme, density,
// notification opts, etc.).
export const updateMyPreferencesSchema = z.object({
  preferredLang: z.enum(["ru", "en", "es", "fr"]).optional(),
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
  email: z.string().email().optional(),
  phone: z.string().nullable().optional(),
  role: userRoleSchema.optional(),
  blocked: z.boolean().optional(),
  linkedClientId: z.string().nullable().optional(),
  // Henry QA Bug #5 — truck unit number for drivers.
  unitNumber: z.string().max(50).nullable().optional(),
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
  // fix/totp-onboarding-verify: short-lived token (10 min) for the confirm-signup
  // step. Required for new users; absent for legacy bootstrapped users.
  pendingConfirmationToken: z.string().optional(),
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;

/** Body for POST /api/auth/totp/confirm-signup */
export const totpConfirmSignupSchema = z.object({
  pendingConfirmationToken: z.string().min(1),
  token: z.string().length(6),
});
export type TotpConfirmSignupInput = z.infer<typeof totpConfirmSignupSchema>;

/** Body for POST /api/auth/totp/resume-setup */
export const totpResumeSetupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type TotpResumeSetupInput = z.infer<typeof totpResumeSetupSchema>;

/** Response from POST /api/auth/totp/resume-setup */
export const totpResumeSetupResponseSchema = z.object({
  otpauthUrl: z.string(),
  totpSecret: z.string(),
  pendingConfirmationToken: z.string(),
});
export type TotpResumeSetupResponse = z.infer<typeof totpResumeSetupResponseSchema>;

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
 * @deprecated driverId is now a first-class field on loadSchema.
 * Kept for backward compatibility with any external code referencing this
 * schema name, but the field no longer needs to be merged additively.
 */
export const loadDriverFieldsSchema = z.object({
  driverId: z.string().optional(),
});

/** loadSchema + booking. Full Phase 4 read shape.
 * driverId is already part of loadSchema, so no explicit merge needed.
 */
export const loadFullSchema = loadWithBookingSchema;
export type LoadFull = z.infer<typeof loadFullSchema>;

/** insertLoadSchema + booking. POST /api/loads accepts this body. */
export const insertLoadFullSchema = insertLoadWithBookingSchema;
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
  /** Driver's carrier company (resolved via user.linkedClientId). */
  client: z
    .object({
      id: z.string(),
      name: z.string(),
      mc: z.string(),
      /** Carrier persona — used by driver portal to show self-dispatch UI. */
      persona: z.enum(["owner_operator", "fleet", "enterprise"]).optional(),
    })
    .nullable(),
  /** Active dispatcher for the driver's client (first active assignment). */
  dispatcher: z
    .object({
      id: z.string(),
      fullName: z.string(),
      email: z.string().email(),
      phone: z.string().nullable(),
    })
    .nullable(),
  currentLoad: loadFullSchema.nullable(),
  todayPickup: dashboardLoadStopSchema.nullable(),
  todayDelivery: dashboardLoadStopSchema.nullable(),
  /** Up to 3 most recent loads, newest first. P0: same shape as Load. */
  recentLoads: z.array(loadFullSchema),
  /** P0 stub — always false. P1 will read from a messages table. */
  hasUnreadMessages: z.boolean(),
  /** P1: filled from driver_documents.expires_at via computePendingDocsForUser.
   *  P0 stub returned [] — shape was {type, expiresAt?}. P1 returns the
   *  superset PendingDoc {id, type, expiresAt|null, daysUntilExpiry, status}.
   *  We keep both shapes compatible by using a passthrough object schema. */
  pendingDocs: z.array(
    z
      .object({
        type: z.string(),
        expiresAt: z.string().nullable().optional(),
      })
      .passthrough(),
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
  name: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type SignupLead = z.infer<typeof signupLeadSchema>;

export const subscribePublicSchema = z.object({
  email: z.string().email().max(254),
  lang: z.string().max(8).optional(),
  referer: z.string().max(500).optional(),
  // Опциональные поля для «Contact us» варианта lead-formы на landing.
  // При простой подписке не передаются — lead создаётся без них.
  name: z.string().min(1).max(120).optional(),
  note: z.string().min(1).max(2000).optional(),
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

// ===========================================================================
// PHASE 4 P1 — Driver operations (documents, check-ins, expenses, issues)
// ===========================================================================
//
// P1 turns the driver portal from "read-only with status switcher" into a
// working tool: drivers upload their own compliance docs (CDL/medical/COI/
// W9), check in at pickup/delivery, file expenses, and report problems
// upstream. All endpoints stay under /api/me/* and follow the same
// tenant-scoping rule from P0 — every read/write filtered by session userId.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Driver documents
// ---------------------------------------------------------------------------
export const driverDocumentTypeSchema = z.enum([
  // Per-driver documents (legacy)
  "cdl",
  "medical",
  "coi",
  "w9",
  "ifta",
  "other",
  // Killer feature #5 + per-user request — compliance docs that can sit
  // on a driver (owner-operator self-files) OR on a client (компания
  // загружает за всех).
  "cargo_insurance",
  "auto_liability",
  "general_liability",
  "ucr_certificate",
  "irp_cab_card",
  "mcs150",
  "dq_file",
  // Killer feature #3 — DQ file per FMCSA §391.51 (per-driver).
  // "medical" + "cdl" + "dq_file" уже есть выше; эти дополняют
  // полный набор для compliance audit.
  "dq_application",         // §391.21 — driver employment application
  "dq_inquiry_prev_employer", // §391.23 — prior employer inquiries
  "dq_mvr",                 // §391.25 — motor vehicle record (annual)
  "dq_road_test",           // §391.31 — road test cert or CDL equivalent
  "dq_annual_review",       // §391.25(c) — annual driving record review
]);
export type DriverDocumentType = z.infer<typeof driverDocumentTypeSchema>;

export const driverDocumentSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  /** Optional carrier (client) scope. NULL when the doc is per-driver only. */
  clientId: z.string().nullable().optional(),
  type: driverDocumentTypeSchema,
  fileName: z.string(),
  storagePath: z.string(),
  expiresAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriverDocument = z.infer<typeof driverDocumentSchema>;

export const uploadDriverDocumentSchema = z.object({
  type: driverDocumentTypeSchema,
  expiresAt: dateOnlySchema.optional(),
  notes: z.string().max(500).optional(),
  /** Admin-only: attach the doc to a carrier instead of the uploader. */
  clientId: z.string().optional(),
});
export type UploadDriverDocumentInput = z.infer<typeof uploadDriverDocumentSchema>;

export const pendingDocSchema = z.object({
  id: z.string(),
  type: driverDocumentTypeSchema,
  expiresAt: z.string().nullable(),
  daysUntilExpiry: z.number().nullable(),
  status: z.enum(["expired", "soon", "ok"]),
});
export type PendingDoc = z.infer<typeof pendingDocSchema>;

// ---------------------------------------------------------------------------
// Load check-ins
// ---------------------------------------------------------------------------
export const checkinKindSchema = z.enum([
  "pickup_arrived",
  "loaded",
  "in_transit",
  "delivery_arrived",
  "delivered",
  "note",
]);
export type CheckinKind = z.infer<typeof checkinKindSchema>;

export const loadCheckinSchema = z.object({
  id: z.string(),
  loadId: z.string(),
  driverUserId: z.string(),
  kind: checkinKindSchema,
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type LoadCheckin = z.infer<typeof loadCheckinSchema>;

export const createCheckinSchema = z
  .object({
    kind: checkinKindSchema,
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      v.kind === "note" ||
      v.kind === "in_transit" ||
      (typeof v.lat === "number" && typeof v.lng === "number"),
    {
      message: "lat and lng are required for arrival/delivery check-ins",
      path: ["lat"],
    },
  );
export type CreateCheckinInput = z.infer<typeof createCheckinSchema>;

// ---------------------------------------------------------------------------
// Driver expenses
// ---------------------------------------------------------------------------
export const expenseCategorySchema = z.enum([
  "fuel",
  "parking",
  "tolls",
  "repair",
  "lumper",
  "other",
]);
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const driverExpenseSchema = z.object({
  id: z.string(),
  driverUserId: z.string(),
  loadId: z.string().nullable(),
  category: expenseCategorySchema,
  amountCents: z.number().int().nonnegative(),
  photoStoragePath: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type DriverExpense = z.infer<typeof driverExpenseSchema>;

export const createExpenseSchema = z.object({
  loadId: z.string().optional(),
  category: expenseCategorySchema,
  amount: z.coerce.number().positive().max(100_000),
  notes: z.string().max(500).optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

// ---------------------------------------------------------------------------
// Fuel transactions — a driver's actual fuel purchases. Distinct from generic
// expenses: these feed IFTA gallons-per-state + MPG analytics. Matches the
// fuel-type buckets the receipt OCR (server/lib/ai/receipt-ocr.ts) returns.
// ---------------------------------------------------------------------------
export const fuelTypeSchema = z.enum(["diesel", "gasoline", "def"]);
export type FuelType = z.infer<typeof fuelTypeSchema>;

export const createFuelTransactionSchema = z.object({
  loadId: z.string().optional(),
  gallons: z.coerce.number().positive().max(500),
  pricePerGallon: z.coerce.number().positive().max(20), // USD per gallon
  total: z.coerce.number().positive().max(5000).optional(), // USD; computed if omitted
  fuelType: fuelTypeSchema.default("diesel"),
  stationName: z.string().max(120).optional(),
  // Station coordinates drive IFTA state attribution. If omitted, the server
  // falls back to the driver's last known GPS location (they're at the pump).
  stationLat: z.coerce.number().min(-90).max(90).optional(),
  stationLng: z.coerce.number().min(-180).max(180).optional(),
  odometerMiles: z.coerce.number().int().nonnegative().max(5_000_000).optional(),
  notes: z.string().max(500).optional(),
  occurredAt: z.string().optional(), // ISO; defaults to now server-side
});
export type CreateFuelTransactionInput = z.infer<typeof createFuelTransactionSchema>;

export const fuelTransactionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  clientId: z.string().nullable(),
  loadId: z.string().nullable(),
  stationName: z.string().nullable(),
  stationLat: z.number().nullable(),
  stationLng: z.number().nullable(),
  fuelType: z.string(),
  gallons: z.number(),
  pricePerGallonCents: z.number().int(),
  totalCents: z.number().int(),
  odometerMiles: z.number().int().nullable(),
  receiptStoragePath: z.string().nullable(),
  notes: z.string().nullable(),
  occurredAt: z.string(),
  createdAt: z.string(),
});
export type FuelTransaction = z.infer<typeof fuelTransactionSchema>;

// ---------------------------------------------------------------------------
// Issues + approval tasks
// ---------------------------------------------------------------------------
export const issueSeveritySchema = z.enum(["info", "warn", "urgent"]);
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;

export const createIssueSchema = z.object({
  loadId: z.string().optional(),
  severity: issueSeveritySchema,
  title: z.string().min(3).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export const approvalTaskTypeSchema = z.enum([
  "driver_issue",
  "driver_booking_request",
  "signup_lead",
]);
export type ApprovalTaskType = z.infer<typeof approvalTaskTypeSchema>;

export const approvalTaskStatusSchema = z.enum([
  "open",
  "in_progress",
  "resolved",
  "dismissed",
]);
export type ApprovalTaskStatus = z.infer<typeof approvalTaskStatusSchema>;

export const approvalTaskSchema = z.object({
  id: z.string(),
  taskType: approvalTaskTypeSchema,
  assigneeRole: userRoleSchema,
  resolvedByUserId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  status: approvalTaskStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  createdByUserId: z.string(),
  createdAt: z.string(),
});
export type ApprovalTask = z.infer<typeof approvalTaskSchema>;

// ===========================================================================
// PHASE 4 P1.1 — Admin approval queue
// ===========================================================================

/** Filters for GET /api/admin/approval-tasks. */
export const approvalTaskListFiltersSchema = paginationParamsSchema.extend({
  status: approvalTaskStatusSchema.optional(),
  taskType: approvalTaskTypeSchema.optional(),
  assigneeRole: userRoleSchema.optional(),
});
export type ApprovalTaskListFilters = z.infer<typeof approvalTaskListFiltersSchema>;

/** Body for PATCH /api/admin/approval-tasks/:id. */
export const resolveApprovalTaskSchema = z.object({
  action: z.enum(["resolve", "dismiss"]),
  resolution: z.string().max(1000).optional(),
});
export type ResolveApprovalTaskInput = z.infer<typeof resolveApprovalTaskSchema>;

/** Approval task with optional creator info (admin queue list). */
export const approvalTaskEnrichedSchema = approvalTaskSchema.extend({
  createdByEmail: z.string().nullable(),
  createdByFullName: z.string().nullable(),
  resolvedByEmail: z.string().nullable(),
});
export type ApprovalTaskEnriched = z.infer<typeof approvalTaskEnrichedSchema>;

// ===========================================================================
// PHASE 4 P0 — Dispatcher portal
// ===========================================================================

/** Response shape for GET /api/dispatch/me/dashboard. */
export const dispatchDashboardSchema = z.object({
  dispatcher: z.object({
    id: z.string(),
    fullName: z.string(),
    email: z.string().email(),
  }),
  stats: z.object({
    assignedClientsCount: z.number(),
    activeLoadsCount: z.number(),
    openTasksCount: z.number(),
  }),
  /** Up to 5 most-recent open tasks routed to this dispatcher. */
  recentOpenTasks: z.array(approvalTaskSchema),
  /** Up to 5 most-recent loads across all my clients, newest first. */
  recentLoads: z.array(loadFullSchema),
  /** My assigned clients (light shape). */
  assignedClients: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      activeDriversCount: z.number(),
      activeLoadsCount: z.number(),
    }),
  ),
});
export type DispatchDashboard = z.infer<typeof dispatchDashboardSchema>;

/** Filters for GET /api/dispatch/loads. */
export const dispatchLoadsListFiltersSchema = paginationParamsSchema.extend({
  clientId: z.string().optional(),
  status: z.enum(["available", "booked", "all"]).optional(),
});
export type DispatchLoadsListFilters = z.infer<typeof dispatchLoadsListFiltersSchema>;
/** Enriched driver shape for the dispatcher assign/reassign dialog.
 *  Returned by GET /api/dispatch/clients/:clientId/drivers. All "context"
 *  fields are nullable — a driver may have never reported GPS, never run a
 *  load, or belong to a client whose equipment we cannot map to a capacity. */
export const dispatchDriverSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  unitNumber: z.string().nullable(),
  driverStatus: driverStatusSchema,
  /** Phase 7 presence: lastSeenAt within 2 minutes. */
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  /** Phase 7 GPS last-known cache. Null = no fix on record. */
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
      source: z.string().nullable(),
      accuracyM: z.number().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
  /** First active (booked) load — gives the dispatcher route context. */
  currentLoad: z
    .object({
      id: z.string(),
      originCity: z.string(),
      originState: z.string(),
      destinationCity: z.string(),
      destinationState: z.string(),
      status: z.enum(["available", "booked"]),
    })
    .nullable(),
  activeLoadsCount: z.number(),
  /** Nominal trailer capacity by client equipment, minus active loads.
   *  MVP assumption: 1 active load occupies 1 slot (loads carry no vehicle
   *  count yet). Null when equipment/client cannot be resolved. */
  capacity: z
    .object({
      total: z.number(),
      used: z.number(),
      free: z.number(),
    })
    .nullable(),
  /** Most recent check-in across all the driver's loads (activity context). */
  lastCheckin: z
    .object({
      kind: checkinKindSchema,
      lat: z.number().nullable(),
      lng: z.number().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
});
export type DispatchDriver = z.infer<typeof dispatchDriverSchema>;
// ===========================================================================
// Broker Trust Signals — Killer Feature #1 (auto write-paths MVP)
// ===========================================================================

export const BROKER_TRUST_SIGNAL_TYPES = [
  "paid_on_time", "paid_late", "paid_never",
  "ratecon_honored", "ratecon_reduced_post_bol",
  "rate_negotiation_fair", "rate_negotiation_aggressive",
  "fast_response", "slow_response", "no_response",
  "detention_paid", "detention_disputed",
  "tonu_paid", "tonu_disputed",
  "lumper_reimbursed", "lumper_not_reimbursed",
  "fraud_attempt", "double_brokered",
  "factoring_friendly", "factoring_blocked",
  // Auto write-path signals
  "load_booked", "load_completed", "load_cancelled_by_broker", "load_refused_by_carrier",
  "authority_revoked", "authority_restored",
] as const;
export type BrokerTrustSignalType = typeof BROKER_TRUST_SIGNAL_TYPES[number];

export const brokerTrustSignalSchema = z.object({
  id: z.string(),
  brokerMc: z.string().min(1),
  brokerName: z.string().nullable().optional(),
  loadId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  signalType: z.enum(BROKER_TRUST_SIGNAL_TYPES),
  positive: z.boolean(),
  valueJson: z.unknown().nullable().optional(),
  notes: z.string().nullable().optional(),
  reportedByUserId: z.string().nullable().optional(),
  source: z.enum(["automatic", "dispatcher", "driver", "fmcsa", "integration"]),
  reportedAt: z.string(),
  createdAt: z.string(),
});
export type BrokerTrustSignal = z.infer<typeof brokerTrustSignalSchema>;
