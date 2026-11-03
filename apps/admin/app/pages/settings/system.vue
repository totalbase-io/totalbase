<script setup lang="ts">
// A saved name or logo shows everywhere through useInstance - read it again.
const { refresh } = useInstance()
const { t } = useI18n()
const api = useAdminApi()

/** GET /admin/api/system (Administration.md §7.10): what this instance runs - read once, nothing to edit. */
interface SystemInfo {
  version: string
  environment: string
  postgres: { version: string, database: string }
}
const { data: system } = useAsyncData('settings-system-about', () => api.get<SystemInfo>('/system').then(r => r.data))
const rows = computed(() => system.value
  ? [
      { label: t('settings.instanceAbout.totalbase'), value: system.value.version },
      { label: t('settings.instanceAbout.environment'), value: system.value.environment },
      { label: t('settings.instanceAbout.postgres'), value: system.value.postgres.version },
      { label: t('settings.instanceAbout.database'), value: system.value.postgres.database }
    ]
  : [])
</script>

<template>
  <SettingsGroupForm
    group="system"
    @saved="refresh().catch(() => undefined)"
  >
    <template #after>
      <section class="mt-6 flex flex-col gap-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
          {{ t('settings.instanceAbout.title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('settings.instanceAbout.description') }}
        </p>
        <dl
          v-if="rows.length"
          class="text-sm"
        >
          <template
            v-for="(row, index) in rows"
            :key="row.label"
          >
            <USeparator v-if="index > 0" />
            <div class="flex items-center justify-between gap-4 py-2">
              <dt class="font-medium">
                {{ row.label }}
              </dt>
              <dd class="text-muted tabular-nums">
                {{ row.value }}
              </dd>
            </div>
          </template>
        </dl>
      </section>
    </template>
  </SettingsGroupForm>
</template>
