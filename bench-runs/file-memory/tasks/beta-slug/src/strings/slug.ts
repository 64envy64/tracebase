import { normalizeForSlug } from "./case.js";

/**
 * Convert any title string into a URL-safe slug.
 *
 * Contract:
 *   - lowercase
 *   - words separated by single '-'
 *   - non-ASCII letters preserved via NFD-fold (café → cafe)
 *   - punctuation collapsed to '-'
 *   - leading/trailing separators trimmed
 */
export function slug(title: string): string {
  // BUG: this drops non-ASCII characters entirely instead of folding
  // them. asciiFold() is imported as part of the case module but not
  // used here. Result: 'café-récipé' → 'caf-rcip'.
  const cleaned = title.replace(/[^a-zA-Z0-9\s-]/g, " ");
  const collapsed = cleaned.replace(/\s+/g, "-");
  return normalizeForSlug(collapsed);
}
