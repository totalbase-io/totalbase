<script setup lang="ts">
/**
 * Authenticator apps to get one from (Security.md §2.17). Under an MFA setup's QR code it is "Don't have an
 * authenticator app?", closed until asked - most people already have one; `open` shows the list as is, for
 * Settings › Access › MFA, where an administrator looks up what to recommend.
 */
defineProps<{ open?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <ul
    v-if="open"
    class="flex flex-col gap-1 text-sm"
  >
    <li
      v-for="app in AUTHENTICATOR_APPS"
      :key="app.name"
    >
      <ULink
        :to="app.url"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium"
      >
        {{ app.name }}
      </ULink>
      <span class="text-muted"> - {{ app.platforms }}</span>
    </li>
  </ul>
  <UCollapsible v-else>
    <UButton
      :label="t('auth.mfa.appsToggle')"
      color="neutral"
      variant="link"
      size="sm"
      trailing-icon="i-lucide-chevron-down"
      class="p-0 group"
      :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
    />
    <template #content>
      <div class="flex flex-col gap-2 pt-2 text-sm">
        <p class="text-muted">
          {{ t('auth.mfa.appsDescription') }}
        </p>
        <MfaAuthenticatorApps open />
      </div>
    </template>
  </UCollapsible>
</template>
