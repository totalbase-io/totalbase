<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <TokensTable
    :header="{
      title: t('users.pages.tokens.title'),
      description: t('users.pages.tokens.description'),
      icon: 'i-lucide-key-round'
    }"
  />
</template>
