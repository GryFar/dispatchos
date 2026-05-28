/**
 * Client display formatting helpers.
 *
 * Henry QA Bug #6+7: "add a company name to the client so that there is
 * client name + managers name (example: TRUCKING- John Cock)"
 *
 * The combined display string is used in table cells, headings, and any
 * other surface that needs to show "Company — Contact" together.
 */

/**
 * Format a client for display, combining the legal/company name with the
 * contact person's name (if present).
 *
 * Examples:
 *   { name: "ACME Trucking", contactPersonName: "John Smith" }
 *     → "ACME Trucking — John Smith"
 *   { name: "ACME Trucking" }
 *     → "ACME Trucking"
 *   { name: "ACME Trucking", contactPersonName: "  " }
 *     → "ACME Trucking"  (blank contactPersonName is ignored)
 */
export function formatClientDisplay(c: {
  name: string;
  contactPersonName?: string | null;
}): string {
  if (c.contactPersonName && c.contactPersonName.trim()) {
    return `${c.name} \u2014 ${c.contactPersonName.trim()}`;
  }
  return c.name;
}
