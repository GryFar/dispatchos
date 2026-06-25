// ===========================================================================
// server/upload.ts — shared multer middleware
// ===========================================================================
//
// Extracted from server/routes.ts so that route modules (routes/me.ts for
// Phase 4 P1 driver documents and expense photos, and any future module)
// can reuse the exact same multer configuration without creating a circular
// import between routes.ts and routes/*. There is only ONE multer instance
// in the whole server — the one exported here.
//
// Constraints (locked):
//   - 10 MB default size limit (overridable via DISPATCHOS_UPLOAD_MAX_MB env).
//   - Extension whitelist: .pdf / .jpg / .jpeg / .png / .txt / .csv.
//   - MIME whitelist: matching subset.
//   - Files land in `uploadsRoot` (resolved by storage.ts).
//
// Anything driver-facing must pass through this — never roll a parallel
// multer in another module; tenant scoping and audit logging assume a single
// upload path.
// ---------------------------------------------------------------------------

import multer from "multer";
import path from "node:path";
import { uploadsRoot } from "./storage";

const allowedUploadExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".txt", ".csv"]);
// Audit V2-13 — dropped "application/octet-stream" from the whitelist; it's the
// browser default for unknown types and effectively neutralised the MIME check.
// The extension whitelist above is the real gate. If a future driver client
// (esp. mobile) starts sending octet-stream for valid PDFs we'll add a
// signature-byte (magic) sniff via the `file-type` npm instead of re-opening
// the MIME wildcard.
const allowedUploadMime = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
  "text/csv",
]);

// Resolve the per-file size cap defensively. `Number(x || 10)` only guards
// falsy values; a truthy-but-non-numeric env (e.g. "10mb", "abc") yields NaN,
// and busboy's `size > limits.fileSize` comparison against NaN is always false,
// silently disabling the cap entirely (unbounded-upload DoS). Require a finite
// positive number and otherwise fall back to the 10 MB default.
const DEFAULT_UPLOAD_MAX_MB = 10;
const rawUploadMaxMb = process.env.DISPATCHOS_UPLOAD_MAX_MB;
const parsedUploadMaxMb = Number(rawUploadMaxMb);
const uploadMaxMb =
  Number.isFinite(parsedUploadMaxMb) && parsedUploadMaxMb > 0
    ? parsedUploadMaxMb
    : DEFAULT_UPLOAD_MAX_MB;
if (
  rawUploadMaxMb !== undefined &&
  rawUploadMaxMb !== "" &&
  uploadMaxMb !== parsedUploadMaxMb
) {
  // eslint-disable-next-line no-console
  console.warn(
    `[upload] Ignoring invalid DISPATCHOS_UPLOAD_MAX_MB=${JSON.stringify(rawUploadMaxMb)}; ` +
      `falling back to ${DEFAULT_UPLOAD_MAX_MB} MB.`,
  );
}

export const upload = multer({
  dest: uploadsRoot,
  limits: { fileSize: uploadMaxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedUploadExtensions.has(extension)) {
      cb(new Error(`File extension ${extension || "(none)"} is not allowed`));
      return;
    }
    if (!allowedUploadMime.has(file.mimetype)) {
      cb(new Error(`MIME type ${file.mimetype} is not allowed`));
      return;
    }
    cb(null, true);
  },
});
