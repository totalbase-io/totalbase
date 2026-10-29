/** A tooltip shows a value, not a document: past this, cut with "…" - the record shows it whole. */
export const TOOLTIP_TEXT_MAX = 500

/** A card's or a cell's text as its tooltip shows it (DataViews.md §5.3). */
export function tooltipText(text: string | null | undefined): string {
  if (!text) return ''
  return text.length > TOOLTIP_TEXT_MAX ? `${text.slice(0, TOOLTIP_TEXT_MAX).trimEnd()}…` : text
}
