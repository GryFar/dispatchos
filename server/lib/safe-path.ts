import path from "node:path";

// Sanitize a single path segment built from user input (e.g. a client name).
// Strips directory separators and ".." traversal so the segment can never
// escape its parent directory when joined.
export function sanitizePathSegment(raw: string): string {
  const cleaned = raw
    .replace(/[/\\]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "unnamed";
}

// True iff `child` resolves to a path inside `parent` (or equal to it).
// Defense-in-depth backstop for sanitizePathSegment.
export function isWithinDir(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
