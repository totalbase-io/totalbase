<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <SettingsGroupForm
    :group="['pool', 'catalog']"
    :title="t('settings.pages.connector.title')"
    :description="t('settings.pages.connector.description')"
  />
</template>
