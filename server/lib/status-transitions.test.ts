// Status-transition guard tests.
// Run: npx tsx server/lib/status-transitions.test.ts
//
// Several review-entity mutations transition a status and must reject a second
// concurrent/duplicate transition rather than double-processing (double-bill,
// approve-then-reject, resolve-twice). Each writes conditionally on the status
// it validated against (WHERE ... AND status = <expected>), so changes===0 →
// "already handled". This locks that observable contract in:
//   - updateInvoice: legal-transition matrix + reject re-transition from a
//     terminal state.
//   - approveSignupLead / rejectSignupLead: a lead can be reviewed once.
//   - resolveApprovalTask: a task can be resolved/dismissed once.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(tmpdir(), "dispatchos-status-transitions-test.db");
const { storage } = await import("../storage");

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
const rnd = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// updateInvoice — legal transition matrix + double-transition rejection
// ---------------------------------------------------------------------------
{
  const inv = storage.createInvoice({
    clientId: `st-client-${rnd()}`,
    weekStart: "2026-02-02",
    weekEnd: "2026-02-08",
    flatFee: 100,
    percentFee: 25,
    grossBooked: 800,
  });
  assert("invoice starts draft", inv.status === "draft", inv.status);

  const sent = storage.updateInvoice(inv.id, { status: "sent" });
  assert("draft -> sent allowed", "invoice" in sent && sent.invoice.status === "sent");
  assert(
    "sent stamps sent_at",
    "invoice" in sent && typeof sent.invoice.sentAt === "string" && !!sent.invoice.sentAt,
  );

  // draft -> paid is not a legal direct transition.
  const illegal = storage.updateInvoice(inv.id, { status: "draft" });
  assert(
    "sent -> draft rejected (invalidTransition)",
    "invalidTransition" in illegal && illegal.from === "sent" && illegal.to === "draft",
  );

  const paid = storage.updateInvoice(inv.id, { status: "paid" });
  assert("sent -> paid allowed", "invoice" in paid && paid.invoice.status === "paid");

  // paid -> draft/sent stays rejected (no forward motion out of paid) — only the
  // reversal path below may move a paid row.
  const paidToSent = storage.updateInvoice(inv.id, { status: "sent" });
  assert(
    "paid -> sent rejected (no forward motion)",
    "invalidTransition" in paidToSent && paidToSent.from === "paid" && paidToSent.to === "sent",
  );

  // paid -> void IS allowed: reconciliation-only. A fully-reversed Stripe charge
  // (refund / credit-note / voided / uncollectible) must be able to flip a
  // locally-'paid' row off 'paid' so DispatchOS stops counting revenue Stripe no
  // longer holds. See handleWebhookEvent's reversal cases in lib/stripe.ts.
  const afterPaid = storage.updateInvoice(inv.id, { status: "void" });
  assert(
    "paid -> void allowed (reversal reconciliation)",
    "invoice" in afterPaid && afterPaid.invoice.status === "void",
  );

  // void remains terminal — a reversed row cannot be resurrected.
  const afterVoid = storage.updateInvoice(inv.id, { status: "paid" });
  assert(
    "void -> paid rejected (void terminal)",
    "invalidTransition" in afterVoid && afterVoid.from === "void",
  );

  const missing = storage.updateInvoice(`inv_does_not_exist_${rnd()}`, { status: "sent" });
  assert("updateInvoice unknown id -> notFound", "notFound" in missing);
}

// ---------------------------------------------------------------------------
// signup lead — approve once, then any further review is rejected
// ---------------------------------------------------------------------------
{
  const { lead } = storage.insertSignupLead({ email: `lead-${rnd()}@example.com` });
  assert("lead starts pending", lead.status === "pending", lead.status);

  const approved = storage.approveSignupLead(lead.id, `INV-${rnd()}`, "reviewer-1");
  assert("approveSignupLead succeeds", "status" in approved && approved.status === "approved");

  // A second reviewer trying to reject the same lead must lose the race.
  const reReject = storage.rejectSignupLead(lead.id, "reviewer-2", "too late");
  assert(
    "reject after approve -> alreadyReviewed(approved)",
    "alreadyReviewed" in reReject && reReject.alreadyReviewed === "approved",
  );

  const reApprove = storage.approveSignupLead(lead.id, "INV-X", "reviewer-3");
  assert("re-approve -> alreadyReviewed", "alreadyReviewed" in reApprove);

  const noLead = storage.approveSignupLead(`lead_missing_${rnd()}`, "INV-Y", "reviewer-1");
  assert("approve unknown lead -> notFound", "notFound" in noLead);
}

// ---------------------------------------------------------------------------
// approval task — resolve/dismiss once
// ---------------------------------------------------------------------------
{
  const task = storage.createApprovalTask({
    taskType: "driver_issue",
    assigneeRole: "dispatcher",
    payload: { note: "check truck" },
    createdByUserId: "creator-1",
  });
  assert("task starts open", task.status === "open", task.status);

  const resolved = storage.resolveApprovalTask(task.id, "resolve", "resolver-1", "fixed");
  assert("resolveApprovalTask succeeds", resolved?.status === "resolved");

  const second = storage.resolveApprovalTask(task.id, "dismiss", "resolver-2");
  assert("second resolve/dismiss -> null (already handled)", second === null);

  const unknown = storage.resolveApprovalTask(`task_missing_${rnd()}`, "resolve", "resolver-1");
  assert("resolve unknown task -> null", unknown === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
