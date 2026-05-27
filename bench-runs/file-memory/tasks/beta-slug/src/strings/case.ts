/** camelCase → kebab-case (preserves acronyms as separate words). */
export function camelToKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/** Convert a string to lower-kebab and strip non-word chars from edges. */
export function normalizeForSlug(s: string): string {
  return camelToKebab(s).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/** ASCII-fold a Unicode string (rough approximation). */
export function asciiFold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
