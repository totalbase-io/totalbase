<script setup lang="ts">
/**
 * What a role a manager manages opens in the App (Security.md §9.7): among the DataViews, dashboards and
 * workflows the manager may share - ones they open themselves; a dashboard an administrator marked delegable;
 * a workflow that runs as its caller - each switched on or off for the role. Opening never grants data: the
 * role still needs its permissions.
 */
const props = defineProps<{ roleId: string }>()

type Kind = 'dataviews' | 'dashboards' | 'workflows'
interface SharedObject {
  id: string
  name: string
  granted: boolean
}

const appApi = useAppApi()
const { t } = useI18n()
const notifyError = useErrorToast()

const KINDS: { kind: Kind, icon: string }[] = [
  { kind: 'dataviews', icon: 'i-lucide-table' },
  { kind: 'dashboards', icon: 'i-lucide-layout-dashboard' },
  { kind: 'workflows', icon: 'i-lucide-workflow' }
]

const { data, pending, error } = await useAsyncData(
  `role-objects-${props.roleId}`,
  async () => (await appApi.get<Record<Kind, SharedObject[]>>(`/roles/${props.roleId}/objects`)).data,
  { default: () => ({ dataviews: [], dashboards: [], workflows: [] }) as Record<Kind, SharedObject[]> }
)

const groups = computed(() => KINDS.filter(({ kind }) => data.value[kind].length > 0))
const busy = ref<string | null>(null)

async function toggle(kind: Kind, object: SharedObject, on: boolean) {
  busy.value = object.id
  try {
    const path = `/roles/${props.roleId}/objects/${kind}/${object.id}`
    if (on) await appApi.put(path)
    else await appApi.del(path)
    object.granted = on
  } catch (err) {
    notifyError(err, t('users.roleObjects.saveError'))
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <div>
      <h2 class="text-sm font-semibold text-highlighted">
        {{ t('users.roleObjects.title') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t('users.roleObjects.description') }}
      </p>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('users.roleObjects.loadError')"
    />
    <UEmpty
      v-else-if="pending || groups.length === 0"
      :loading="pending"
      icon="i-lucide-app-window"
      :title="pending ? undefined : t('users.roleObjects.empty')"
      variant="naked"
      size="sm"
    />
    <div
      v-for="{ kind, icon } in groups"
      v-else
      :key="kind"
      class="flex flex-col gap-2"
    >
      <p class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <UIcon
          :name="icon"
          class="size-3.5"
        />
        {{ t(`users.roleObjects.kind.${kind}`) }}
      </p>
      <ul class="divide-y divide-default rounded-lg border border-default">
        <li
          v-for="object in data[kind]"
          :key="object.id"
          class="flex items-center justify-between gap-3 px-3 py-2"
        >
          <span class="truncate text-sm">{{ object.name }}</span>
          <USwitch
            :model-value="object.granted"
            :loading="busy === object.id"
            :aria-label="t('users.roleObjects.toggleLabel', { name: object.name })"
            @update:model-value="(on: boolean) => toggle(kind, object, on)"
          />
        </li>
      </ul>
    </div>
  </section>
</template>
