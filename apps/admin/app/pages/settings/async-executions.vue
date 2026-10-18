<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <SettingsGroupForm
    :group="['async_executions', 'outbox']"
    :title="t('settings.pages.asyncExecutions.title')"
    :description="t('settings.pages.asyncExecutions.description')"
  />
</template>
