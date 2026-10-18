<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <SettingsGroupForm
    :group="['api', 'query']"
    :title="t('settings.pages.limits.title')"
  />
</template>
