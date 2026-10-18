/** A JSON text field's error for a form: null when it parses, else a short message (the workflow operation modals' JSON inputs). */
export function jsonError(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch {
    return useNuxtApp().$i18n.t('shell.invalidJson')
  }
}
