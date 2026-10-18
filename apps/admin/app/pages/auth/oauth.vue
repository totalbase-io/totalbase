<script setup lang="ts">
// Where a provider sign-in from the sign-in page comes back (/api/auth/oauth/{slug}/callback redirects
// here): the session token, or why there is none, in the fragment - never in the query string, so it
// reaches no server log. Signed in, it goes where the sign-in page was asked to, inside what the
// account's access opens, like a password sign-in (pages/login.vue).
definePageMeta({ layout: false })

const { t } = useI18n()
const session = useSession()
const failure = ref<string | null>(null)

const MESSAGES: Record<string, string> = {
  access_denied: 'auth.oauth.accessDenied',
  email_required: 'auth.oauth.emailRequired',
  email_not_verified: 'auth.oauth.emailNotVerified'
}

function takeRedirect(): string | null {
  try {
    const redirect = sessionStorage.getItem(OAUTH_REDIRECT_KEY)
    sessionStorage.removeItem(OAUTH_REDIRECT_KEY)
    return redirect
  } catch {
    return null
  }
}

onMounted(async () => {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  // The token leaves the address bar at once - nothing keeps it in history.
  history.replaceState(null, '', window.location.pathname)
  const token = fragment.get('token')
  if (!token) {
    const error = fragment.get('error') ?? ''
    failure.value = t(MESSAGES[error] ?? 'auth.genericError')
    return
  }
  session.setToken(token)
  try {
    await session.refreshProfile()
  } catch {
    session.clear()
    failure.value = t('auth.genericError')
    return
  }
  const access = session.access.value
  const home = portalHomeFor(access)
  const redirect = takeRedirect() ?? home
  await navigateTo(isPortalPathAllowed(redirect, access, session.modules.value) ? redirect : home, { replace: true })
})
</script>

<template>
  <AuthPublicCard>
    <div
      v-if="!failure"
      class="flex items-center gap-2 text-sm text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      {{ t('auth.oauth.signingIn') }}
    </div>
    <template v-else>
      <h1 class="text-lg font-semibold text-highlighted">
        {{ t('auth.oauth.failed') }}
      </h1>
      <p class="text-sm text-muted">
        {{ failure }}
      </p>
      <UButton
        :label="t('auth.goToSignIn')"
        to="/login"
        block
      />
    </template>
  </AuthPublicCard>
</template>
