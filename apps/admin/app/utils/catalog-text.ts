import type { Composer } from 'vue-i18n'

/**
 * A shared catalog's text in the UI's language (Admin_UI.md §14):
 * the widget catalog, the column types, the settings metadata, the dashboard
 * widgets, the workflow operations live in packages the server reads too, in
 * English. The admin translates them through a key derived from the catalog
 * key - `designer.catalog.widgets.UButton.label` - and falls back to the
 * package's English when a language has no such key.
 */
export function catalogText(i18n: Pick<Composer, 't' | 'te'>, key: string, english: string | undefined): string {
  if (english === undefined) return ''
  return i18n.te(key) ? i18n.t(key) : english
}

/** `catalogText` bound to the current language - for a component or composable. */
export function useCatalogText() {
  const i18n = useI18n()
  return (key: string, english: string | undefined) => catalogText(i18n, key, english)
}
