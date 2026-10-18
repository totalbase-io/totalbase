<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <SessionsTable
    :header="{
      title: t('users.pages.sessions.title'),
      description: t('users.pages.sessions.description'),
      icon: 'i-lucide-monitor-smartphone'
    }"
  />
</template>
