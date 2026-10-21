import { COLUMN_INPUTS, isColumnInputKey } from '@totalbase/tb-catalog'
import { useCatalogText } from '~/utils/catalog-text'

/**
 * The column input catalog's words in the UI's language (DataViews.md §16) - each entry's name and
 * description, and what it is technically: its widget and the props that make it that control ("UInput · type
 * number"), shown beside the name so nothing is hidden behind it.
 */
export function useColumnInputText() {
  const text = useCatalogText()
  const label = (key: string) => (isColumnInputKey(key) ? text(`database.columnInputs.${key}.label`, COLUMN_INPUTS[key].label) : key)
  const description = (key: string) => (isColumnInputKey(key) ? text(`database.columnInputs.${key}.description`, COLUMN_INPUTS[key].description) : '')
  return { label, description, technical: columnInputTechnical }
}

/** An entry as its widget and props: `UInput · type number`, `UEditor · markdown`. */
export function columnInputTechnical(key: string): string {
  if (!isColumnInputKey(key)) return ''
  const entry = COLUMN_INPUTS[key]
  const props = Object.entries(entry.props ?? {}).map(([prop, value]) => (prop === 'type' ? `type ${String(value)}` : String(value)))
  return [entry.widget, ...props].join(' · ')
}
