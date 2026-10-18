/**
 * The one error toast of the admin: `notifyError(error, title)` shows
 * `title` with the error as the viewer reads it (`apiErrorMessage`: the
 * server's message, translated when it is one of TotalBase's own) under it;
 * with no title, the message alone. `fallback` is the text for something
 * that isn't an API error at all - "Unknown error" otherwise.
 */
export function useErrorToast() {
  const toast = useToast()
  const message = useApiErrorMessage()
  const { t } = useI18n()
  return function notifyError(error: unknown, title?: string, fallback?: string) {
    const text = message(error, fallback ?? t('common.unknownError'))
    toast.add(title ? { title, description: text, color: 'error' } : { title: text, color: 'error' })
  }
}
