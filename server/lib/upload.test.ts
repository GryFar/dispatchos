// Regression tests for the shared multer upload middleware (server/upload.ts).
// Run: npx tsx server/lib/upload.test.ts
//
// NOTE on location: this test lives under server/lib/ (not next to its source
// at server/upload.ts) because the unit-test runner scripts/smoke-ai.mjs only
// recurses server/lib/. A test placed at server/upload.test.ts is never picked
// up by `npm run smoke:ai` / CI, so it would give false confidence.
//
// server/upload.ts exports exactly ONE symbol: `upload`, the single multer
// instance the whole server shares. It imports `uploadsRoot` from ./storage,
// which opens better-sqlite3, so we point DISPATCHOS_DB_PATH at a unique temp
// file BEFORE importing (matching server/lib/stripe-charge.test.ts).
//
// These lock in two fixes a nearby refactor must not silently revert:
//
//   1) limits.files === 1 — the multer instance caps the file COUNT at 1.
//      Pre-fix the config had only `{ fileSize: ... }` (no `files`), so a
//      crafted multipart body could stream an unbounded number of part
//      headers. Asserting `limits.files === 1` FAILS on the pre-fix config
//      (where it was undefined) and PASSES now.
//
//   2) The MIME allow-set (enforced via `upload.fileFilter`) accepts
//      image/jpg, image/jpeg, image/png, application/pdf and REJECTS
//      dangerous types like text/html and application/x-msdownload.
//      `allowedUploadMime` is module-private, so we exercise the real gate —
//      the exported instance's fileFilter — rather than inventing an import.
//      A refactor that drops a needed type or re-opens the filter to a
//      dangerous type FAILS here.
//
// Everything is deterministic: fixed file fixtures, no clock dependence in the
// assertions, no HTTP, no network. The only varying input is the temp DB path
// suffix, which exists solely to keep parallel test runs isolated.

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DISPATCHOS_DB_PATH = join(
  tmpdir(),
  `dispatchos-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

const { upload } = await import("../upload");

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// Multer exposes the resolved config directly on the instance.
const u = upload as unknown as {
  limits?: { fileSize?: number; files?: number };
  fileFilter?: (
    req: unknown,
    file: { originalname: string; mimetype: string },
    cb: (err: Error | null, accept?: boolean) => void,
  ) => void;
};

// Drive the real fileFilter synchronously and report whether it accepted.
// multer's fileFilter invokes its callback synchronously here (no async work),
// so the closure-captured result is populated by the time the call returns.
function filterDecision(originalname: string, mimetype: string): {
  accepted: boolean;
  error: Error | null;
} {
  let accepted = false;
  let error: Error | null = null;
  let called = false;
  if (typeof u.fileFilter !== "function") {
    throw new Error("upload.fileFilter is not a function");
  }
  u.fileFilter({}, { originalname, mimetype }, (err, accept) => {
    called = true;
    error = err ?? null;
    accepted = err == null && accept === true;
  });
  if (!called) {
    throw new Error("fileFilter did not invoke its callback synchronously");
  }
  return { accepted, error };
}

// ---------------------------------------------------------------------------
// 1) Files-count limit pinned to 1.
//    REGRESSION: pre-fix `limits` was `{ fileSize: ... }` with no `files`
//    key, so this read undefined and the strict-equality check FAILED.
//    It PASSES only because the single-file cap is now present.
// ---------------------------------------------------------------------------
{
  assert("limits object is present", !!u.limits, JSON.stringify(u.limits));
  assert(
    "limits.files === 1 (file-count cap locked in)",
    u.limits?.files === 1,
    `got ${JSON.stringify(u.limits?.files)}`,
  );
}

// ---------------------------------------------------------------------------
// 2) Documented 10 MB per-file size cap (default, no env override here).
//    REGRESSION: guards against a refactor that drops/zeros the size limit,
//    which would re-open the unbounded-upload DoS the source comment warns of.
// ---------------------------------------------------------------------------
{
  assert(
    "limits.fileSize === 10 MiB (default cap)",
    u.limits?.fileSize === 10 * 1024 * 1024,
    `got ${JSON.stringify(u.limits?.fileSize)}`,
  );
}

// ---------------------------------------------------------------------------
// 3) MIME allow-set INCLUDES the four required content types.
//    `allowedUploadMime` is module-private, so we assert via the exported
//    instance's fileFilter (the real enforcement point). The filter checks the
//    extension first; we pair each MIME with a whitelisted, matching extension
//    so the decision under test is purely the MIME gate.
//    REGRESSION: dropping any of these from the allow-set (e.g. removing the
//    non-standard "image/jpg" that some Android WebViews emit) flips the
//    corresponding assertion to FAIL.
// ---------------------------------------------------------------------------
{
  const allowed: Array<[string, string]> = [
    ["scan.pdf", "application/pdf"],
    ["photo.jpg", "image/jpg"], // non-standard but accepted on purpose
    ["photo.jpeg", "image/jpeg"],
    ["photo.png", "image/png"],
  ];
  for (const [name, mime] of allowed) {
    const d = filterDecision(name, mime);
    assert(
      `allow-set includes ${mime}`,
      d.accepted === true,
      d.error ? d.error.message : "rejected with no error",
    );
  }
}

// ---------------------------------------------------------------------------
// 4) MIME allow-set EXCLUDES dangerous types.
//    Use a whitelisted extension (.png) so the extension gate passes and the
//    rejection is attributable to the MIME gate specifically — proving the
//    allow-set does not contain these types.
//    REGRESSION: re-opening the filter to a dangerous MIME (or re-adding the
//    old "application/octet-stream" wildcard that was dropped per Audit V2-13)
//    would make one of these accepted and FAIL the test.
// ---------------------------------------------------------------------------
{
  const dangerous: Array<[string, string]> = [
    ["evil.png", "text/html"],
    ["evil.png", "application/x-msdownload"],
  ];
  for (const [name, mime] of dangerous) {
    const d = filterDecision(name, mime);
    assert(
      `allow-set excludes dangerous ${mime}`,
      d.accepted === false && d.error instanceof Error,
      `accepted=${d.accepted} error=${d.error ? d.error.message : "none"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5) Extension gate still bites: a whitelisted MIME with a non-whitelisted
//    extension is rejected. This documents that the extension whitelist is the
//    primary gate (per the V2-13 comment) and a refactor cannot quietly let an
//    .exe through just because the caller spoofs an image MIME.
// ---------------------------------------------------------------------------
{
  const d = filterDecision("payload.exe", "image/png");
  assert(
    "extension gate rejects .exe even with allowed MIME",
    d.accepted === false && d.error instanceof Error,
    `accepted=${d.accepted} error=${d.error ? d.error.message : "none"}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
