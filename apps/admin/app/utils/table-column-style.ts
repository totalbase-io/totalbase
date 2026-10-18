/**
 * How a table's cells look (`CellStyle`, @totalbase/tb-catalog) as classes -
 * a Dashboard TABLE, a page's Table. Every key optional: an unset one
 * keeps the type-based default (numbers right-aligned, the base font).
 */
import type { CellStyle, ColumnOptionPresentation, WIDGET_COLORS } from '@totalbase/tb-catalog'
import { h, type VNode } from 'vue'

export type TableAlign = NonNullable<CellStyle['align']>
export type TableFontSize = NonNullable<CellStyle['fontSize']>

export const TABLE_ALIGN_CLASS: Record<TableAlign, string> = { left: 'text-left', center: 'text-center', right: 'text-right' }
export const TABLE_FONT_SIZE_CLASS: Record<TableFontSize, string> = { xs: 'text-xs', sm: 'text-sm', base: 'text-base', lg: 'text-lg' }

/** The cell classes for a column's style - font size, weight, italics, monospace (numbers get tabular digits either way). */
export function columnStyleClass(style: CellStyle, numeric: boolean, defaultSize: TableFontSize = 'sm'): string {
  return [
    TABLE_FONT_SIZE_CLASS[style.fontSize ?? defaultSize],
    style.bold ? 'font-semibold' : '',
    style.italic ? 'italic' : '',
    style.underline ? 'underline' : '',
    style.strike ? 'line-through' : '',
    style.mono || numeric ? 'tabular-nums' : '',
    style.mono ? 'font-mono' : ''
  ].filter(Boolean).join(' ')
}

/** A `value` link's href from the cell's own text. */
export function valueLinkHref(kind: 'url' | 'email' | 'tel', text: string): string {
  if (kind === 'email') return `mailto:${text}`
  if (kind === 'tel') return `tel:${text}`
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
}

/** A CHECK value's badge, by its theme color - literal classes, so Tailwind sees each one. */
const OPTION_BADGE_CLASS: Record<(typeof WIDGET_COLORS)[number], string> = {
  primary: 'bg-primary/10 text-primary',
  secondary: 'bg-secondary/10 text-secondary',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
  neutral: 'bg-elevated text-default'
}

/**
 * A CHECK value shown as its badge - its color and icon (a column's
 * `options`) - or null when it sets neither. `icon` draws an icon by name
 * (UIcon) - passed in, so this stays free of components for its tests.
 */
export function optionBadge(text: string, option: ColumnOptionPresentation | undefined, icon?: (name: string) => VNode): VNode | null {
  if (!option?.color && !option?.icon) return null
  return h('span', { class: ['inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', OPTION_BADGE_CLASS[option.color ?? 'neutral']] }, [
    option.icon && icon ? icon(option.icon) : null,
    text
  ])
}

/** A cell's look as classes, only what it sets - a grid keeps its own defaults for the rest. */
export function setCellStyleClass(style: CellStyle): string {
  return [
    style.align ? TABLE_ALIGN_CLASS[style.align] : '',
    style.fontSize ? TABLE_FONT_SIZE_CLASS[style.fontSize] : '',
    style.bold ? 'font-semibold' : '',
    style.italic ? 'italic' : '',
    style.underline ? 'underline' : '',
    style.strike ? 'line-through' : '',
    style.mono ? 'font-mono' : ''
  ].filter(Boolean).join(' ')
}

/** A cell's background - a tint of its palette color, light enough for text over it in either mode. */
export function backgroundTint(shade: string | undefined): string | undefined {
  return shade ? `color-mix(in srgb, ${shade} 14%, transparent)` : undefined
}
