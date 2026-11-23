<script setup lang="ts">
// Settings > General > Lockdown (Security.md §2.21). The banner and the sign-in page read the state through
// useInstance - read it again once a change is saved. The repeating window's schedule reads in the instance's zone.
const { refresh } = useInstance()
const api = useAdminApi()
const { data: timezone } = await useAsyncData('settings-lockdown-timezone', async () =>
  String((await api.get<Record<string, unknown>>('/settings/system')).data['system.timezone'] ?? ''))
</script>

<template>
  <SettingsGroupForm
    group="lockdown"
    :cron-timezone="timezone || 'UTC'"
    @saved="refresh().catch(() => undefined)"
  />
</template>
