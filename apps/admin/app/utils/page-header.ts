import type { ButtonProps, DropdownMenuItem } from '@nuxt/ui'

/**
 * A page header's secondary action (PageHeader.vue's `actions`): a
 * button on desktop, an item of the header's "⋮" menu on a phone -
 * declared as data so one list renders both ways. The primary action
 * (New, Save, Publish) stays a button in PageHeader's default slot,
 * visible at every width.
 */
export interface HeaderAction {
  label: string
  icon: string
  onSelect?: () => void
  /** The button's color on desktop, the item's color in the phone menu. Default neutral. */
  color?: ButtonProps['color']
  disabled?: boolean
  loading?: boolean
  /** Desktop: a tooltip on the button. Phone: the item's description. */
  tooltip?: string
  /** A menu rather than an action: a dropdown button on desktop, a submenu on a phone. */
  children?: DropdownMenuItem[]
  /** Desktop: a square icon button, the label as its tooltip (a Refresh). The phone menu still shows the label. */
  iconOnly?: boolean
}

/**
 * A list's row selection (PageHeader.vue's `selection`). While `count` is
 * above zero the header is about the selection: on desktop "N selected",
 * the bulk actions and Clear selection before the usual actions; on a
 * phone the title becomes "✕ N selected", destructive (error) actions stay
 * as icon buttons and the rest go to the "⋮".
 */
export interface HeaderSelection {
  count: number
  /** What the selection adds up to - a summed column's total (DataViews.md §4.9). */
  summary?: string | null
  actions: HeaderAction[]
  onClear: () => void
}
