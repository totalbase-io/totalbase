// Client-side mirror of @totalbase/shared's slugify() (Foundations.md §9.3).
// Duplicated
// rather than imported so the admin bundle doesn't pull in a backend
// package - same algorithm, same result. Server-side validation via
// @totalbase/shared remains authoritative; this is a convenience-only
// live preview while the user types.
export function slugify(rawName: string): string {
  const slug = rawName
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // word separators -> hyphen
    .replace(/[^a-z0-9-]/g, '') // drop anything else
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
  return slug.slice(0, 32).replace(/-+$/, '')
}
