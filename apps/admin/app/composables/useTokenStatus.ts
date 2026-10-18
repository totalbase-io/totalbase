/**
 * How a personal access token reads - its state, expiry and last use - the
 * same wherever it's shown (TokenRow, in a user's Tokens tab and the
 * global API tokens page). "Expiring" is within `api_keys.rotation_warning_days`;
 * the api_keys settings group is fetched once and shared.
 */
import { formatDistanceToNow } from 'date-fns'
import type { UserApiToken } from '~/types/security'

export type TokenState = 'active' | 'expiring' | 'expired' | 'revoked'

const DAY_MS = 24 * 60 * 60 * 1000

/** `labelKey` is a locale key (`users.tokenStatus.state.*`), translated where shown. */
export const TOKEN_STATE_BADGE: Record<TokenState, { labelKey: string, color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  active: { labelKey: 'users.tokenStatus.state.active', color: 'success' },
  expiring: { labelKey: 'users.tokenStatus.state.expiring', color: 'warning' },
  expired: { labelKey: 'users.tokenStatus.state.expired', color: 'error' },
  revoked: { labelKey: 'users.tokenStatus.state.revoked', color: 'neutral' }
}

export const TOKEN_EXPIRY_CLASS: Record<TokenState, string> = {
  active: 'text-muted',
  expiring: 'text-warning',
  expired: 'text-error',
  revoked: 'text-muted'
}

/** The browser-format fallback for a token's day ("5 Mar 2026") when the user has no date format - see useDateTimeFormat(). */
export const TOKEN_DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }

export function useTokenStatus() {
  const api = useAdminApi()
  const session = useSession()
  const dates = useDateTimeFormat()
  const { t } = useI18n()
  const ui = useUiLocale()
  const fromNow = (value: string) => formatDistanceToNow(new Date(value), { addSuffix: true, locale: ui.dateFns.value })
  const formatTokenDay = (value: string) => dates.date(value, TOKEN_DAY)
  // The default lifetime (the create form's preselected expiry) and the
  // "expiring soon" window. Settings are Administrators-only: an app user
  // (My account) keeps the registry defaults below.
  const { data: keySettings } = useAsyncData(
    'settings-api-keys',
    () => session.access.value === 'ADMIN'
      ? api.get<Record<string, unknown>>('/settings/api_keys').then(r => r.data)
      : Promise.resolve<Record<string, unknown>>({}),
    { default: (): Record<string, unknown> => ({}) }
  )
  const defaultTtlDays = computed(() => Number(keySettings.value['api_keys.default_ttl_days'] ?? 365))
  const warningDays = computed(() => Number(keySettings.value['api_keys.rotation_warning_days'] ?? 30))

  function tokenState(token: UserApiToken): TokenState {
    if (!token.active || token.revokedAt) return 'revoked'
    if (!token.expiresAt) return 'active'
    const left = new Date(token.expiresAt).getTime() - Date.now()
    if (left <= 0) return 'expired'
    return left <= warningDays.value * DAY_MS ? 'expiring' : 'active'
  }

  /** Can still authenticate - an expired or revoked token only waits to be deleted. */
  function usable(token: UserApiToken) {
    const state = tokenState(token)
    return state === 'active' || state === 'expiring'
  }

  function expiryText(token: UserApiToken): string {
    const state = tokenState(token)
    if (state === 'revoked') return token.revokedAt ? t('users.tokenStatus.revokedOn', { date: formatTokenDay(token.revokedAt) }) : t('users.tokenStatus.state.revoked')
    if (!token.expiresAt) return t('users.tokenStatus.neverExpires')
    if (state === 'expired') return t('users.tokenStatus.expiredOn', { date: formatTokenDay(token.expiresAt) })
    if (state === 'expiring') return t('users.tokenStatus.expiresIn', { when: fromNow(token.expiresAt) })
    return t('users.tokenStatus.expiresOn', { date: formatTokenDay(token.expiresAt) })
  }

  function lastUsedText(token: UserApiToken): string {
    return token.lastUsedAt ? t('users.tokenStatus.lastUsed', { when: fromNow(token.lastUsedAt) }) : t('users.tokenStatus.neverUsed')
  }

  return { defaultTtlDays, warningDays, tokenState, usable, expiryText, lastUsedText }
}
