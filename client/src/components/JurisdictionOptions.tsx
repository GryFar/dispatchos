import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { JURISDICTIONS_BY_COUNTRY } from "@shared/jurisdictions";

/**
 * Grouped <SelectItem> options (US states + Canadian provinces) for a shadcn
 * <Select>. Render inside <SelectContent>. US and Canada appear as two separate
 * labelled sections; the selected value stays the 2-letter code (ON, TX, …), so
 * nothing downstream (pipeline, geocoder, IFTA) changes.
 */
export function JurisdictionOptions() {
  return (
    <>
      {JURISDICTIONS_BY_COUNTRY.map((group) => (
        <SelectGroup key={group.country}>
          <SelectLabel>{group.label}</SelectLabel>
          {group.items.map((j) => (
            <SelectItem key={j.code} value={j.code}>
              {j.code}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}
