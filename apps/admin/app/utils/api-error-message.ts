import type { Composer } from 'vue-i18n'
import { DEFAULT_UI_LANGUAGE } from '@totalbase/shared'
import { AdminApiError } from '~/utils/admin-api-error'

/**
 * An API error as the viewer reads it (Admin_UI.md §14): in
 * English, the server's message itself; in another language, TotalBase's
 * own errors with a fixed meaning are translated by code
 * (`errors.<CODE>` in the locale files); one whose message carries details
 * keeps the server's message. PostgreSQL's - a CHECK, a trigger's RAISE
 * EXCEPTION, a constraint's message - are never translated: they are the
 * database author's words. `fallback` when it isn't an API error at all.
 */
export function apiErrorMessage(i18n: Pick<Composer, 't' | 'te' | 'locale'>, error: unknown, fallback?: string): string {
  if (!(error instanceof AdminApiError)) return fallback ?? i18n.t('errors.unknown')
  return apiErrorText(i18n, error)
}

/** One of the API's errors - `{ code, source, message }` as a response's `errors` carries it - as the viewer reads it. */
export function apiErrorText(i18n: Pick<Composer, 't' | 'te' | 'locale'>, error: ApiErrorLike): string {
  // A UNIQUE or FOREIGN KEY violation whose constraint has no message of its own: PostgreSQL's raw English
  // ("duplicate key value violates…") read in the UI's language instead - a constraint's COMMENT stays as written.
  const plain = constraintDefault(error)
  if (plain) return i18n.t(`errors.constraint.${plain}`)
  // English is the server's own language: its message, as written there, is the English text.
  if (i18n.locale.value === DEFAULT_UI_LANGUAGE) return error.message
  // A refusal names the action, the table and whose roles (deniedMessage, @totalbase/errors) - read in the UI's
  // language with those details, never only "you may not".
  const denied = error.code === 'ACTION_DENIED' ? /^No (READ|CREATE|UPDATE|DELETE|EXECUTE) grant on (\S+) for (.+)\.$/.exec(error.message) : null
  if (denied) {
    const who = denied[3] === 'your roles' ? i18n.t('errors.deniedYourRoles') : denied[3]!
    return i18n.t('errors.actionDeniedOn', { action: i18n.t(`errors.actions.${denied[1]}`), resource: denied[2]!, who })
  }
  if (error.source !== 'POSTGRESQL' && error.code && i18n.te(`errors.${error.code}`)) return i18n.t(`errors.${error.code}`)
  return error.message
}

/** An error as the API sends it - an AdminApiError, or one of a record's errors. */
export interface ApiErrorLike {
  code?: string
  source?: 'TOTALBASE' | 'POSTGRESQL'
  message: string
}

/** `apiErrorText` bound to the current language - for a component. */
export function useApiErrorText() {
  const i18n = useI18n()
  return (error: ApiErrorLike) => apiErrorText(i18n, error)
}

/** `apiErrorMessage` bound to the current language - for a component. */
export function useApiErrorMessage() {
  const i18n = useI18n()
  return (error: unknown, fallback?: string) => apiErrorMessage(i18n, error, fallback)
}

/** Which plain message a raw PostgreSQL UNIQUE, FOREIGN KEY or CHECK violation reads as - none for one with its own message. */
function constraintDefault(error: ApiErrorLike): 'duplicate' | 'inUse' | 'missing' | 'check' | null {
  if (error.source !== 'POSTGRESQL') return null
  if (error.code === 'UNIQUE_VIOLATION' && /^duplicate key value violates unique constraint/.test(error.message)) return 'duplicate'
  if (error.code === 'CHECK_VIOLATION' && /^new row for relation .* violates check constraint/.test(error.message)) return 'check'
  if (error.code !== 'FOREIGN_KEY_VIOLATION') return null
  if (/^update or delete on table .* (violates foreign key|violates RESTRICT setting)/.test(error.message)) return 'inUse'
  if (/^insert or update on table .* violates foreign key/.test(error.message)) return 'missing'
  return null
}
