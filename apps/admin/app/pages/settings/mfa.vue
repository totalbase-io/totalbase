<script setup lang="ts">
// Settings > Access > MFA (Security.md §2.17): the requirement and the notice, then the authenticator apps
// people are shown when they set MFA up - what to recommend to them.
const { t } = useI18n()
</script>

<template>
  <SettingsGroupForm group="mfa">
    <template #after>
      <SettingsSection
        :title="t('settings.mfa.appsTitle')"
        :description="t('settings.mfa.appsDescription')"
      >
        <MfaAuthenticatorApps open />
      </SettingsSection>
    </template>
  </SettingsGroupForm>
</template>
