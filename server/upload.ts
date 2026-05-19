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
const allowedUploadMime = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
  "text/csv",
  "application/octet-stream",
]);

export const upload = multer({
  dest: uploadsRoot,
  limits: { fileSize: Number(process.env.DISPATCHOS_UPLOAD_MAX_MB || 10) * 1024 * 1024 },
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

export { allowedUploadExtensions, allowedUploadMime };
