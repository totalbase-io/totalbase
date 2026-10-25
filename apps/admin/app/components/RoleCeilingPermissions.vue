<script setup lang="ts">
/**
 * A manager's grants on a role they manage (Security.md §9.6): only what the role's parent may do - each
 * resource and action of its ceiling (GET /app/api/roles/:role/ceiling), a subset of its fields, and an
 * optional row filter the server AND-combines with the parent's. ALLOW only. The server checks every write
 * (PERMISSION_EXCEEDS_CEILING); this offers only what it will take.
 */
import type { PermissionAction } from '~/types/permission'

const props = defineProps<{ roleId: string }>()

interface CeilingEntry {
  resource: { id: string, schema: string, name: string, type: string }
  actions: Partial<Record<PermissionAction, { fields: string[] }>>
}
interface Grant {
  resource: string
  action: PermissionAction
  whereClause: unknown
  fields: { field: string, effect: 'ALLOW' | 'DENY' }[]
}

const appApi = useAppApi()
const { t } = useI18n()
const toast = useToast()
const notifyError = useErrorToast()

const ACTIONS: PermissionAction[] = ['READ', 'CREATE', 'UPDATE', 'DELETE', 'EXECUTE']

const { data, pending, error, refresh } = await useAsyncData(`role-ceiling-${props.roleId}`, async () => {
  const [ceiling, grants] = await Promise.all([
    appApi.get<CeilingEntry[]>(`/roles/${props.roleId}/ceiling`),
    appApi.get<Grant[]>(`/roles/${props.roleId}/permissions`)
  ])
  return { ceiling: ceiling.data, grants: grants.data }
}, { default: () => ({ ceiling: [] as CeilingEntry[], grants: [] as Grant[] }) })

const grantOf = (resourceId: string, action: PermissionAction) =>
  data.value.grants.find(g => g.resource === resourceId && g.action === action) ?? null

const rows = computed(() => data.value.ceiling.map(entry => ({
  entry,
  label: `${entry.resource.schema}.${entry.resource.name}`,
  actions: ACTIONS.filter(action => entry.actions[action])
})))

const columns = computed(() => [
  { accessorKey: 'label', header: t('users.roleCeiling.resource') },
  { id: 'actions', header: t('users.roleCeiling.actions') }
])

// --- One (resource, action) grant ---
const editing = ref<{ entry: CeilingEntry, action: PermissionAction } | null>(null)
const editorOpen = computed({
  get: () => editing.value !== null,
  set: (open: boolean) => {
    if (!open) editing.value = null
  }
})
const draftFields = ref<string[]>([])
const draftWhere = ref('')
const whereError = ref<string | null>(null)
const saving = ref(false)

function openGrant(entry: CeilingEntry, action: PermissionAction) {
  const existing = grantOf(entry.resource.id, action)
  const allowed = entry.actions[action]?.fields ?? []
  draftFields.value = existing ? existing.fields.filter(f => f.effect === 'ALLOW').map(f => f.field) : [...allowed]
  draftWhere.value = existing?.whereClause ? JSON.stringify(existing.whereClause, null, 2) : ''
  whereError.value = null
  editing.value = { entry, action }
}

function toggleField(field: string, on: boolean) {
  draftFields.value = on ? [...new Set([...draftFields.value, field])] : draftFields.value.filter(f => f !== field)
}

const grantPath = () => `/roles/${props.roleId}/resources/${editing.value!.entry.resource.id}/permissions/${editing.value!.action}`

async function save() {
  let where: unknown = null
  if (draftWhere.value.trim()) {
    try {
      where = JSON.parse(draftWhere.value)
    } catch {
      whereError.value = t('users.roleCeiling.whereInvalid')
      return
    }
  }
  saving.value = true
  try {
    await appApi.put(grantPath(), { data: { effect: 'ALLOW', where, fields: draftFields.value.map(field => ({ field, effect: 'ALLOW' })) } })
    toast.add({ title: t('users.roleCeiling.saved'), color: 'success' })
    editing.value = null
    await refresh()
  } catch (err) {
    notifyError(err, t('users.roleCeiling.saveError'))
  } finally {
    saving.value = false
  }
}

async function remove() {
  saving.value = true
  try {
    await appApi.del(grantPath())
    toast.add({ title: t('users.roleCeiling.removed'), color: 'success' })
    editing.value = null
    await refresh()
  } catch (err) {
    notifyError(err, t('users.roleCeiling.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <div>
      <h2 class="text-sm font-semibold text-highlighted">
        {{ t('users.roleCeiling.title') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t('users.roleCeiling.description') }}
      </p>
    </div>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('users.roleCeiling.loadError')"
    />
    <UEmpty
      v-else-if="pending || rows.length === 0"
      :loading="pending"
      icon="i-lucide-shield-off"
      :title="pending ? undefined : t('users.roleCeiling.empty')"
      variant="naked"
      size="sm"
    />
    <UTable
      v-else
      :data="rows"
      :columns="columns"
      sticky
    >
      <template #actions-cell="{ row }">
        <div class="flex flex-wrap gap-1.5">
          <UButton
            v-for="action in row.original.actions"
            :key="action"
            :label="t(`users.roleCeiling.action.${action}`)"
            :icon="grantOf(row.original.entry.resource.id, action) ? 'i-lucide-check' : 'i-lucide-plus'"
            :color="grantOf(row.original.entry.resource.id, action) ? 'primary' : 'neutral'"
            :variant="grantOf(row.original.entry.resource.id, action) ? 'soft' : 'outline'"
            size="xs"
            @click="openGrant(row.original.entry, action)"
          />
        </div>
      </template>
    </UTable>

    <UModal
      v-model:open="editorOpen"
      :title="editing ? t('users.roleCeiling.editTitle', { action: t(`users.roleCeiling.action.${editing.action}`), resource: `${editing.entry.resource.schema}.${editing.entry.resource.name}` }) : ''"
      :description="t('users.roleCeiling.editDescription')"
    >
      <template #body>
        <div
          v-if="editing"
          class="flex flex-col gap-4"
        >
          <UFormField
            :label="t('users.roleCeiling.fields')"
            :description="t('users.roleCeiling.fieldsHelp')"
          >
            <div class="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <UCheckbox
                v-for="field in editing.entry.actions[editing.action]?.fields ?? []"
                :key="field"
                :model-value="draftFields.includes(field)"
                :label="field"
                @update:model-value="(v: boolean | 'indeterminate') => toggleField(field, v === true)"
              />
            </div>
          </UFormField>
          <UFormField
            :label="t('users.roleCeiling.where')"
            :description="t('users.roleCeiling.whereHelp')"
            :error="whereError ?? undefined"
          >
            <UTextarea
              v-model="draftWhere"
              :rows="4"
              autoresize
              class="w-full font-mono"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UButton
            v-if="editing && grantOf(editing.entry.resource.id, editing.action)"
            :label="t('users.roleCeiling.remove')"
            color="error"
            variant="ghost"
            :disabled="saving"
            @click="remove"
          />
          <span v-else />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="editing = null"
            />
            <UButton
              :label="t('common.save')"
              :loading="saving"
              @click="save"
            />
          </div>
        </div>
      </template>
    </UModal>
  </section>
</template>
