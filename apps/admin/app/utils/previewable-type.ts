/** What a file preview shows in the page - the types the server serves inline too (Administration.md §10.5). */
const PREVIEWABLE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * The type a file previews as - its essence, parameters dropped and lower-cased - or null when it downloads instead:
 * judged from an allow-list, so `image/svg+xml; charset=utf-8` (a document that runs its own scripts) never frames.
 */
export function previewableType(type: string): string | null {
  const essence = type.split(';')[0]!.trim().toLowerCase()
  return PREVIEWABLE_TYPES.has(essence) ? essence : null
}
