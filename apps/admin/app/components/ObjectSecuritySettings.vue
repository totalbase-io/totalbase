<script setup lang="ts">
/**
 * Settings > Security of a DataView (DataViews.md §3.6) or a Dashboard (Dashboards.md §2.6,
 * D26): which roles open it - object access, never data (Security.md §7.1). Not part of the draft: a
 * change applies at once, the banner says so. A DataView over a table: each role says what it may do there (its
 * effective permissions, trimmed by Allow) and warns when it can't read it.
 */
import type { EffectiveResourceEntry } from '~/types/effective-permission'
import type { RoleSourceAccess } from '~/components/ObjectRolesList.vue'

const props = defineProps<{
  /** What it guards - its roles at `/<kind>s/:id/roles`. */
  kind: 'dataview' | 'dashboard'
  objectId: string
  /** The source table's resource id - none for an external frame or a page without a record table. */
  sourceResource: string | null
  sourceName?: string
  /** The DataView's Allow, as being edited. */
  allow?: readonly string[]
  /** Allow's tab - a role's "taken by Allow" links there. */
  allowLink?: string
}>()

const api = useAdminApi()
const rolesApi = useRolesApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const { data: allRoles } = useRoleOptions()
const roles = computed(() => allRoles.value ?? [])

const roleIds = ref<string[]>([])
const loaded = ref(false)
const saving = ref(false)
watch(() => props.objectId, async (id) => {
  try {
    roleIds.value = await rolesApi.grantedOn(props.kind, id)
  } catch (error) {
    notifyError(error, t('users.dataviewRoles.loadError'))
  } finally {
    loaded.value = true
  }
}, { immediate: true })

/** What each role may do on the source - its effective permissions there, read once per role. */
const access = ref<Record<string, RoleSourceAccess>>({})
watch([roles, () => props.sourceResource], async ([list, resource]) => {
  if (!resource) return
  const entries = await Promise.all(list.filter(r => !r.adminAccess).map(async (role) => {
    try {
      const decisions = (await api.get<EffectiveResourceEntry[]>(`/roles/${role.id}/effective-permissions`)).data.find(d => d.resource === resource)
      const on = (action: 'READ' | 'CREATE' | 'UPDATE' | 'DELETE') => decisions?.actions[action]?.decision === 'ALLOW'
      return [role.id, { read: on('READ'), create: on('CREATE'), update: on('UPDATE'), delete: on('DELETE') }] as const
    } catch {
      return null
    }
  }))
  access.value = Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null))
}, { immediate: true })

/** Applied at once - a grant to an administrators' role is redundant and goes on the next save. */
async function save(next: string[]) {
  const previous = roleIds.value
  roleIds.value = next
  saving.value = true
  try {
    const offered = new Set(roles.value.filter(r => !r.adminAccess).map(r => r.id))
    roleIds.value = (await api.put<string[]>(`/${props.kind}s/${props.objectId}/roles`, { data: { roleIds: next.filter(id => offered.has(id)) } })).data
  } catch (error) {
    roleIds.value = previous
    notifyError(error, t('users.dataviewRoles.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsSection
    :title="t('users.dataviewRoles.label')"
    :description="kind === 'dashboard' ? t('users.dataviewRoles.dashboardDescription') : sourceResource ? t('users.dataviewRoles.descriptionWithSource') : t('users.dataviewRoles.description')"
  >
    <UAlert
      color="info"
      variant="subtle"
      icon="i-lucide-zap"
      :title="t('users.objectRoles.appliesAtOnce')"
    />
    <UEmpty
      v-if="!loaded"
      loading
      variant="naked"
      size="sm"
    />
    <ObjectRolesList
      v-else
      :model-value="roleIds"
      :roles="roles"
      :access="sourceResource ? access : undefined"
      :allow="allow"
      :source-name="sourceName"
      :allow-link="allowLink"
      :disabled="saving"
      @update:model-value="save"
    />
  </SettingsSection>
</template>
