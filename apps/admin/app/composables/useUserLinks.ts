/**
 * Invitation / password-reset links for one user, the admin side:
 * `copyLink` issues a fresh single-use link without emailing it
 * (`delivery: "link"`) and copies it, for sharing another way;
 * `reportSendFailure` turns a failed email - SMTP not set up yet, or the
 * relay refusing it - into a toast that offers exactly that. Issuing a
 * link retires the previous one of the same kind (server-side).
 */
import { useApiErrorMessage } from '~/utils/api-error-message'

export type UserLinkKind = 'invite' | 'reset-password'

/** Locale keys under `users.userLinks.<kind>.*`. */
const LINK_KEY: Record<UserLinkKind, string> = {
  'invite': 'invite',
  'reset-password': 'resetPassword'
}

export function useUserLinks() {
  const api = useAdminApi()
  const toast = useToast()
  const { t } = useI18n()
  const errorMessage = useApiErrorMessage()
  const notifyError = useErrorToast()

  async function copyLink(userId: string, kind: UserLinkKind) {
    try {
      const { data } = await api.post<{ actionUrl: string }>(`/users/${userId}/${kind}`, { data: { delivery: 'link' } })
      await navigator.clipboard.writeText(data.actionUrl)
      toast.add({
        title: t(`users.userLinks.${LINK_KEY[kind]}.copied`),
        description: t('users.userLinks.copiedDescription'),
        color: 'success'
      })
    } catch (err) {
      notifyError(err, t(`users.userLinks.${LINK_KEY[kind]}.createError`))
    }
  }

  function reportSendFailure(err: unknown, userId: string, kind: UserLinkKind, title: string) {
    const mailProblem = err instanceof AdminApiError && (err.code === 'SMTP_NOT_CONFIGURED' || err.code === 'EMAIL_SEND_FAILED')
    toast.add({
      title,
      description: errorMessage(err),
      color: mailProblem ? 'warning' : 'error',
      ...(mailProblem && {
        duration: 0,
        actions: [{ label: t('users.userLinks.copyInstead'), icon: 'i-lucide-link', onClick: () => copyLink(userId, kind) }]
      })
    })
  }

  return { copyLink, reportSendFailure }
}
