<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <SettingsGroupForm
    :group="['transactions', 'idempotency']"
    :title="t('settings.pages.transactions.title')"
    :description="t('settings.pages.transactions.description')"
  />
</template>
