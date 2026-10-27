<script setup lang="ts">
/**
 * Settings > Realtime (Data_API.md §16): the generic settings form, and
 * above it what realtime subscriptions need from PostgreSQL - read live by
 * GET /admin/api/realtime: wal_level = logical, the REPLICATION attribute on
 * TotalBase's role, CREATE on the database for the publication, a free
 * replication slot - and how many tables expose Realtime.
 */
interface RealtimeStatus {
  walLevel: string
  replication: boolean
  createOnDatabase: boolean
  maxReplicationSlots: number
  usedReplicationSlots: number
  ready: boolean
  tables: number
}

const { t } = useI18n()
const api = useAdminApi()

const { data: status } = await useAsyncData('settings-realtime-status', async () => (await api.get<RealtimeStatus>('/realtime')).data)

const requirements = computed(() => {
  const s = status.value
  if (!s) return []
  return [
    { label: t('settings.realtime.walLevel'), ok: s.walLevel === 'logical', detail: t('settings.realtime.walLevelDetail', { value: s.walLevel }) },
    { label: t('settings.realtime.replication'), ok: s.replication, detail: t('settings.realtime.replicationDetail') },
    { label: t('settings.realtime.createOnDatabase'), ok: s.createOnDatabase, detail: t('settings.realtime.createOnDatabaseDetail') },
    {
      label: t('settings.realtime.slots'),
      ok: s.usedReplicationSlots < s.maxReplicationSlots,
      detail: t('settings.realtime.slotsDetail', { used: s.usedReplicationSlots, max: s.maxReplicationSlots })
    }
  ]
})
</script>

<template>
  <SettingsGroupForm group="realtime">
    <template #intro="{ settings }">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-semibold">
              {{ t('settings.realtime.requirements') }}
            </h3>
            <UBadge
              :label="!settings?.['realtime.enabled'] ? t('settings.realtime.off') : status?.ready ? t('settings.realtime.ready') : t('settings.realtime.notReady')"
              :color="!settings?.['realtime.enabled'] ? 'neutral' : status?.ready ? 'success' : 'error'"
              variant="subtle"
            />
          </div>
        </template>
        <div class="flex flex-col gap-4">
          <ul class="flex flex-col divide-y divide-default">
            <li
              v-for="requirement in requirements"
              :key="requirement.label"
              class="flex items-start gap-3 py-2 first:pt-0 last:pb-0"
            >
              <UIcon
                :name="requirement.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
                :class="requirement.ok ? 'text-success' : 'text-error'"
                class="size-5 shrink-0 mt-0.5"
              />
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  {{ requirement.label }}
                </p>
                <p class="text-sm text-muted">
                  {{ requirement.detail }}
                </p>
              </div>
            </li>
          </ul>
          <p class="text-sm text-muted">
            {{ t('settings.realtime.tables', { count: status?.tables ?? 0 }) }}
          </p>
        </div>
      </UCard>
    </template>
  </SettingsGroupForm>
</template>
