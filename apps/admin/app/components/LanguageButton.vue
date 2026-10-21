<script setup lang="ts">
import { UI_LANGUAGES, type UiLanguage } from '@totalbase/shared'
import { PUBLIC_LANGUAGE_KEY } from '~/utils/public-language'

/**
 * The language switch of the pages with no user (Admin_UI.md §14): sign-in and the public auth
 * pages. A visitor's choice for this browser - kept in localStorage, read again at boot by
 * plugins/i18n-language.client.ts - until a signed-in user's own preference takes over. Beside the color mode
 * switch, in its shape: a ghost icon button opening a menu.
 */
const { locale, setLocale, t } = useI18n()

const items = computed(() => UI_LANGUAGES.map(language => ({
  label: language.name,
  type: 'checkbox' as const,
  checked: locale.value === language.code,
  onSelect: () => choose(language.code)
})))

async function choose(code: UiLanguage) {
  await setLocale(code)
  try {
    localStorage.setItem(PUBLIC_LANGUAGE_KEY, code)
  } catch {
    // Private mode or blocked storage: the choice still applies until a reload.
  }
}
</script>

<template>
  <UDropdownMenu :items="items">
    <UButton
      icon="i-lucide-languages"
      color="neutral"
      variant="ghost"
      :aria-label="t('account.preferences.language.label')"
    />
  </UDropdownMenu>
</template>
