// Client-side mirror of packages/schema's validateIdentifier()
// (IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/, max 63 chars) - a
// convenience-only live sanitizer for InputPgIdentifier.vue, same
// "duplicated, not imported, server stays authoritative" tradeoff as
// slugify.ts. Unlike slugify() (hyphens, for dataview slugs), this keeps
// underscores and the leading-letter/underscore rule Postgres itself
// enforces for unquoted identifiers.
export function sanitizePgIdentifier(raw: string): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[\s-]+/g, '_') // whitespace/dashes -> underscore
    .replace(/[^a-z0-9_]/g, '') // drop anything else
    .replace(/_+/g, '_') // collapse repeated underscores
    .replace(/^[0-9]+/, '') // a leading digit isn't a valid start char
  return sanitized.slice(0, 63)
}
