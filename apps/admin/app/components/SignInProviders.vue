<script setup lang="ts">
/**
 * The sign-in page's provider buttons (Security.md §2.11): one per provider an
 * administrator shows there, up to three; more than three fold into one "Sign in with…" menu so the
 * card keeps its size. Each leads to the provider through /api/auth/oauth/{slug}, which comes back to
 * pages/auth/oauth.vue with the session.
 */
import type { SignInProvider } from '~/composables/useInstance'

const props = defineProps<{ providers: SignInProvider[] }>()
const { t } = useI18n()
const route = useRoute()

/** Where to go once signed in survives the trip to the provider - the callback page reads it back. */
function remember() {
  try {
    if (typeof route.query.redirect === 'string') sessionStorage.setItem(OAUTH_REDIRECT_KEY, route.query.redirect)
    else sessionStorage.removeItem(OAUTH_REDIRECT_KEY)
  } catch {
    // No storage: the callback lands on the user's home.
  }
}

function go(provider: SignInProvider) {
  remember()
  window.location.assign(provider.signInUrl)
}

function iconOf(provider: SignInProvider): string {
  if (provider.type === 'GOOGLE') return 'i-simple-icons-google'
  if (provider.type === 'GITHUB') return 'i-simple-icons-github'
  return 'i-lucide-key-round'
}

const MAX_BUTTONS = 3
const menu = computed(() => [props.providers.map(provider => ({ label: provider.name, icon: iconOf(provider), onSelect: () => go(provider) }))])
</script>

<template>
  <div
    v-if="providers.length"
    class="flex flex-col gap-2"
  >
    <USeparator :label="t('auth.login.or')" />
    <template v-if="providers.length <= MAX_BUTTONS">
      <UButton
        v-for="provider in providers"
        :key="provider.slug"
        :icon="iconOf(provider)"
        :label="t('auth.login.continueWith', { name: provider.name })"
        color="neutral"
        variant="outline"
        block
        @click="go(provider)"
      />
    </template>
    <UDropdownMenu
      v-else
      :items="menu"
      :content="{ align: 'center' }"
      :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width)' }"
    >
      <UButton
        icon="i-lucide-log-in"
        trailing-icon="i-lucide-chevron-down"
        :label="t('auth.login.signInWith')"
        color="neutral"
        variant="outline"
        block
      />
    </UDropdownMenu>
  </div>
</template>
