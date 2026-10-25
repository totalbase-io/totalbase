<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { isWorkflowsRole } from '~/types/security'
import type RoleForm from '~/components/RoleForm.vue'
import type { Resource, ResourceType } from '~/types/resource'
import {
  ACTIONS_BY_RESOURCE_TYPE,
  roleIcon,
  protectedFieldReason,
  type FieldGrant,
  type Permission,
  type PermissionAction
} from '~/types/permission'

// A role's administrator editor (pages/roles/[id].vue): its permissions,
// access flags, members and managers - all Admin API.
const props = defineProps<{ roleId: string }>()
const roleId = props.roleId
const api = useAdminApi()
const rolesApi = useRolesApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const ALL_ACTIONS: PermissionAction[] = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE']
const MATRIX_COLUMNS = computed<TableColumn<Resource>[]>(() => [
  { id: 'resource', header: t('users.roleEditor.resource') },
  ...ALL_ACTIONS.map(action => ({ id: action, header: action, meta: { class: { th: 'text-center', td: 'text-center' } } })),
  { id: 'actions', header: '', meta: { class: { th: 'w-12', td: 'w-12 text-right' } } }
])
const { data: role, pending: rolePending, error: roleError, refresh: refreshRole } = await useAsyncData(
  `role-${roleId}`,
  async () => {
    const found = await rolesApi.get(roleId)
    if (!found) throw createError({ statusCode: 404, statusMessage: t('users.roleEditor.notFound') })
    return found
  }
)

// --- Actions on the role itself (the header's "⋮" menu): activate and delete; its fields are the Settings tab.
// All disabled for the reserved Administrators role, which the server refuses to change. ---
async function onRoleSaved() {
  await Promise.all([refreshRole(), refreshNuxtData(['roles-all', 'role-options'])])
}

const togglingActive = ref(false)
async function toggleActive() {
  if (!role.value) return
  togglingActive.value = true
  try {
    await rolesApi.update(roleId, { active: !role.value.active })
    await onRoleSaved()
  } catch (err) {
    notifyError(err, t('users.roleEditor.updateError'))
  } finally {
    togglingActive.value = false
  }
}

const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
const deleting = ref(false)
watch(deleteOpen, (isOpen) => {
  if (isOpen) deleteConfirmed.value = false
})
async function deleteRole() {
  deleting.value = true
  try {
    await rolesApi.remove(roleId)
    deleteOpen.value = false
    toast.add({ title: t('users.roleEditor.deleted'), color: 'success' })
    await refreshNuxtData(['roles-all', 'role-options'])
    await navigateTo('/roles')
  } catch (err) {
    notifyError(err, t('users.roleEditor.deleteError'))
  } finally {
    deleting.value = false
  }
}

const roleMenuItems = computed(() => {
  const reserved = role.value?.reserved === true
  return [
    [
      role.value?.active
        ? { label: t('users.roleEditor.deactivate'), icon: 'i-lucide-toggle-left', disabled: reserved, onSelect: toggleActive }
        : { label: t('users.roleEditor.activate'), icon: 'i-lucide-toggle-right', disabled: reserved, onSelect: toggleActive }
    ],
    [{ label: t('users.duplicateRole.action'), icon: 'i-lucide-copy', disabled: reserved, onSelect: () => { duplicateOpen.value = true } }],
    [{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, disabled: reserved, onSelect: () => { deleteOpen.value = true } }]
  ]
})
const duplicateOpen = ref(false)

const { resources, refresh: refreshResources } = useResourcesList()

const { data: grants, refresh: refreshGrants } = await useAsyncData(
  `role-${roleId}-permissions`,
  () => rolesApi.permissions(roleId),
  { default: () => [] }
)

const grantMap = computed(() => {
  const map = new Map<string, Permission>()
  for (const g of grants.value ?? []) map.set(`${g.resource}:${g.action}`, g)
  return map
})

function grantFor(resourceId: string, action: PermissionAction) {
  return grantMap.value.get(`${resourceId}:${action}`) ?? null
}
function isApplicable(type: ResourceType, action: PermissionAction) {
  return (ACTIONS_BY_RESOURCE_TYPE[type] as PermissionAction[]).includes(action)
}

// --- Matrix ---
// TABLE, then VIEW, then FUNCTION, then name asc within each - same
// ordering as ResourcesBrowser.vue and effective-permissions.vue.
const TYPE_ORDER: Record<ResourceType, number> = { TABLE: 0, VIEW: 1, FUNCTION: 2 }

// One schema at a time, `public` first: a select of the schemas that hold
// resources. `totalbase` (TotalBase's own tables - users, roles, files,
// folders, ...) is one of them, last, with its own "Apply default
// permissions": those grants are a higher-stakes decision
// (totalbase-guardrails.ts) and never sit mixed in with everyday tables.
const schema = ref('public')
const schemaOptions = computed(() => {
  const schemas = [...new Set((resources.value ?? []).map(r => r.schema))]
    .sort((a, b) => Number(a === 'totalbase') - Number(b === 'totalbase') || Number(b === 'public') - Number(a === 'public') || a.localeCompare(b))
  return schemas.map(value => ({ label: value, value, icon: value === 'totalbase' ? 'i-lucide-shield-alert' : 'i-lucide-folder' }))
})
// A database without `public` (or with nothing in it) opens on its first schema.
watch(schemaOptions, (options) => {
  if (options.length > 0 && !options.some(o => o.value === schema.value)) schema.value = options[0]!.value
}, { immediate: true })
// --- Sections, each its own URL (?section=), in the format of a DataView's and a Dashboard's settings ---
const route = useRoute()
type SectionKey = 'general' | 'permissions' | 'users' | 'reviews'
const SECTIONS: { key: SectionKey, icon: string }[] = [
  { key: 'general', icon: 'i-lucide-settings-2' },
  { key: 'permissions', icon: 'i-lucide-list-checks' },
  { key: 'users', icon: 'i-lucide-users' },
  { key: 'reviews', icon: 'i-lucide-clipboard-check' }
]
const LABEL_KEY: Record<SectionKey, string> = { general: 'general', permissions: 'permissions', users: 'members', reviews: 'reviews' }
const section = computed<SectionKey>(() => {
  const asked = route.query.section as SectionKey
  return SECTIONS.some(s => s.key === asked) ? asked : 'general'
})
const sectionItems = computed(() => SECTIONS.map(s => ({
  label: t(`users.roleEditor.tabs.${LABEL_KEY[s.key]}`),
  icon: s.icon,
  to: { query: { section: s.key === 'general' ? undefined : s.key } },
  active: section.value === s.key
})))
const settingsForm = ref<InstanceType<typeof RoleForm> | null>(null)
const search = ref('')
const visibleResources = computed(() => {
  const term = search.value.trim().toLowerCase()
  const list = (resources.value ?? []).filter(r => r.schema === schema.value)
  const filtered = term
    ? list.filter(r => r.name.toLowerCase().includes(term) || r.schema.toLowerCase().includes(term))
    : list
  return [...filtered].sort((a, b) =>
    (TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
    || a.name.localeCompare(b.name)
  )
})

const refreshingMatrix = ref(false)
async function refreshMatrix() {
  refreshingMatrix.value = true
  try {
    await Promise.all([refreshResources(), refreshGrants()])
  } finally {
    refreshingMatrix.value = false
  }
}

// "Apply Default Permissions" (totalbase schema only) - the grants are
// the server's (POST /roles/{id}/totalbase-defaults); it never touches a
// grant on a table outside its list.
const isApplyDefaultsPopoverOpen = ref(false)
const applyingDefaults = ref(false)
async function applyDefaults() {
  applyingDefaults.value = true
  try {
    const result = await applyTotalbaseDefaultPermissions(api, roleId)
    isApplyDefaultsPopoverOpen.value = false
    await refreshGrants()
    toast.add({
      title: t('users.roleEditor.defaultsApplied', result.applied.length),
      // The role's own grants are never replaced by a default - say which were kept.
      description: [
        result.kept.length > 0 ? t('users.roleEditor.defaultsKept', { grants: result.kept.map(g => `${g.table} ${g.action}`).join(', ') }) : '',
        result.missing.length > 0 ? t('users.roleEditor.defaultsMissing', { tables: result.missing.join(', ') }) : ''
      ].filter(Boolean).join(' ') || undefined,
      color: result.missing.length > 0 ? 'warning' : 'success'
    })
  } catch (err) {
    notifyError(err, t('users.roleEditor.defaultsError'))
  } finally {
    applyingDefaults.value = false
  }
}

const { loadColumns } = useCatalogColumns()
const editor = ref<{ open: (resource: Resource, action: PermissionAction, existing: Permission | null) => void } | null>(null)

// Every cell click opens the editor sidebar (RolePermissionEditor.vue),
// seeded with the cell's current grant.
function openCell(resource: Resource, action: PermissionAction) {
  if (!isApplicable(resource.type, action)) return
  editor.value?.open(resource, action, grantFor(resource.id, action))
}

// --- Row actions (the "⋯" at the end of each row) - one-click presets
// scoped to a single resource, never the whole matrix (a matrix-wide bulk
// action was rejected for its blast radius). One popover per row: pick
// the action, then confirm it in place - the same popover, so the
// confirmation stays anchored to the row it acts on.
type RowActionKind = 'allowAll' | 'readOnly' | 'clearAll'
const rowActionsOpenFor = ref<string | null>(null)
const pendingRowAction = ref<RowActionKind | null>(null)
const runningRowActionFor = ref<string | null>(null)

function setRowActionsOpen(resourceId: string, open: boolean) {
  rowActionsOpenFor.value = open ? resourceId : null
  pendingRowAction.value = null
}

function grantedActions(resource: Resource): PermissionAction[] {
  return ALL_ACTIONS.filter(action => grantFor(resource.id, action))
}

function rowActionItems(resource: Resource): Array<{ kind: RowActionKind, label: string, icon: string, disabled?: boolean }> {
  return [
    { kind: 'allowAll', label: t('users.roleEditor.allowAll'), icon: 'i-lucide-shield-check' },
    // READ only exists on tables and views - a function is EXECUTE only.
    ...(isApplicable(resource.type, 'READ') ? [{ kind: 'readOnly' as const, label: t('users.roleEditor.readOnly'), icon: 'i-lucide-eye' }] : []),
    { kind: 'clearAll', label: t('users.roleEditor.clearAll'), icon: 'i-lucide-eraser', disabled: grantedActions(resource).length === 0 }
  ]
}

function rowActionDescription(resource: Resource, kind: RowActionKind): string {
  const target = `${resource.schema}.${resource.name}`
  const columns = resource.type === 'TABLE' || resource.type === 'VIEW' ? t('users.roleEditor.withEveryColumn') : ''
  if (kind === 'allowAll') return t('users.roleEditor.allowAllConfirm', { target, columns })
  if (kind === 'readOnly') return t('users.roleEditor.readOnlyConfirm', { target, columns })
  return t('users.roleEditor.clearAllConfirm', { target, actions: grantedActions(resource).join(', ') })
}

/** Every column the role may be granted (never a protectedFieldReason() one - the server ignores those anyway). */
async function grantableFields(resource: Resource): Promise<FieldGrant[]> {
  if (resource.type !== 'TABLE' && resource.type !== 'VIEW') return []
  return (await loadColumns(resource))
    .filter(c => !protectedFieldReason(c))
    .map(c => ({ field: c.name, effect: 'ALLOW' as const }))
}

const allow = (resource: Resource, action: PermissionAction, fields: FieldGrant[]) =>
  api.put(`/roles/${roleId}/resources/${resource.id}/permissions/${action}`, { data: { effect: 'ALLOW', fields, where: null } })
const clear = (resource: Resource, action: PermissionAction) =>
  api.del(`/roles/${roleId}/resources/${resource.id}/permissions/${action}`)

async function runRowAction(resource: Resource, kind: RowActionKind) {
  runningRowActionFor.value = resource.id
  try {
    if (kind === 'allowAll') {
      const fields = await grantableFields(resource)
      await Promise.all((ACTIONS_BY_RESOURCE_TYPE[resource.type] as PermissionAction[]).map(action => allow(resource, action, fields)))
    } else if (kind === 'readOnly') {
      const fields = await grantableFields(resource)
      await allow(resource, 'READ', fields)
      await Promise.all(grantedActions(resource).filter(action => action !== 'READ').map(action => clear(resource, action)))
    } else {
      await Promise.all(grantedActions(resource).map(action => clear(resource, action)))
    }
    setRowActionsOpen(resource.id, false)
    await refreshGrants()
    toast.add({ title: t(`users.roleEditor.done.${kind}`, { name: resource.name }), color: 'success' })
  } catch (err) {
    // A partial failure can leave some actions changed - reload the matrix
    // so it shows what really stuck.
    await refreshGrants()
    notifyError(err, t('users.roleEditor.permissionsError'))
  } finally {
    runningRowActionFor.value = null
  }
}
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="role?.name ?? t('common.role')"
        :description="role?.description ?? undefined"
        :icon="role ? roleIcon(role) : 'i-lucide-shield'"
        height="editor"
        :menu="role ? roleMenuItems : undefined"
        :menu-loading="togglingActive"
      >
        <!-- Reserved and the access badges are informational - no room
        for them on a phone; Inactive stays. -->
        <div
          v-if="role"
          class="flex items-center gap-2"
        >
          <UBadge
            v-if="role.reserved"
            :label="t('users.roleEditor.reserved')"
            icon="i-lucide-lock"
            color="neutral"
            variant="subtle"
            class="page-header__tall px-2.5 max-md:hidden"
          />
          <UBadge
            v-if="!role.active"
            :label="t('common.inactive')"
            color="warning"
            variant="subtle"
            class="page-header__tall px-2.5"
          />
          <RoleAccessBadges
            :role="role"
            size="header"
            class="max-md:hidden"
          />
        </div>
      </PageHeader>
    </template>
    <template
      v-if="role"
      #toolbar
    >
      <UNavigationMenu
        :items="sectionItems"
        orientation="horizontal"
        highlight
        :aria-label="t('users.roleEditor.sectionsNav')"
        :ui="{ item: 'shrink-0' }"
        class="overflow-x-auto"
      />
    </template>

    <UAlert
      v-if="roleError"
      color="error"
      variant="subtle"
      :title="roleError.message"
    />

    <template v-if="role">
      <!-- An admin-access role (Administrators, the Workflows system
          role) bypasses permissions entirely - a matrix of "—"
          would suggest it has no access, and its grants would never apply. -->
      <div
        v-if="section === 'permissions' && role.adminAccess"
        class="pt-4"
      >
        <UAlert
          icon="i-lucide-shield-check"
          color="neutral"
          variant="subtle"
          :title="t('users.roleEditor.bypassTitle', { name: role.name })"
          :description="t('users.roleEditor.bypassDescription')"
        />
      </div>
      <div
        v-else-if="section === 'permissions'"
        class="flex flex-col gap-3 pt-4"
      >
        <div class="flex items-center gap-3">
          <div class="flex-1" />
          <UPopover
            v-if="schema === 'totalbase'"
            v-model:open="isApplyDefaultsPopoverOpen"
          >
            <UButton
              :label="t('users.roleEditor.applyDefaults')"
              icon="i-lucide-shield-check"
              color="neutral"
              variant="outline"
              :loading="applyingDefaults"
            />
            <template #content>
              <div class="flex flex-col gap-2 p-3 w-72">
                <p class="text-sm">
                  {{ t('users.roleEditor.applyDefaultsHelp') }}
                </p>
                <UButton
                  :label="t('common.apply')"
                  color="primary"
                  size="sm"
                  :loading="applyingDefaults"
                  @click="applyDefaults"
                />
              </div>
            </template>
          </UPopover>
          <USelect
            v-model="schema"
            :items="schemaOptions"
            value-key="value"
            :icon="schema === 'totalbase' ? 'i-lucide-shield-alert' : 'i-lucide-folder'"
            :aria-label="t('users.roleEditor.schema')"
            class="w-44"
          />
          <UInput
            v-model="search"
            :aria-label="t('users.roleEditor.filterResources')"
            icon="i-lucide-search"
            :placeholder="t('users.roleEditor.filterResources')"
            class="w-full sm:w-64"
          />
          <UTooltip :text="t('common.refresh')">
            <UButton
              :aria-label="t('common.refresh')"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="outline"
              square
              :loading="refreshingMatrix"
              @click="refreshMatrix"
            />
          </UTooltip>
        </div>

        <p
          v-if="visibleResources.length === 0"
          class="text-sm text-muted py-8 text-center"
        >
          {{ search ? t('users.roleEditor.noMatch', { search }) : t('users.roleEditor.noResources') }}
        </p>
        <UTable
          v-else
          sticky
          :data="visibleResources"
          :columns="MATRIX_COLUMNS"
        >
          <template #resource-cell="{ row: { original: resource } }">
            <div class="flex items-center gap-2">
              <ResourceTypeIcon :type="resource.type" />
              <div class="flex flex-col">
                <span class="font-medium text-highlighted">{{ resource.name }}</span>
                <span class="text-xs text-muted">{{ resource.schema }}</span>
              </div>
            </div>
          </template>
          <template
            v-for="action in ALL_ACTIONS"
            :key="action"
            #[`${action}-cell`]="{ row: { original: resource } }"
          >
            <button
              v-if="isApplicable(resource.type, action)"
              type="button"
              class="inline-flex items-center justify-center"
              :aria-label="t('users.roleEditor.cellLabel', { action, name: resource.name })"
              @click="openCell(resource, action)"
            >
              <UBadge
                v-if="grantFor(resource.id, action)"
                :color="grantFor(resource.id, action)!.effect === 'ALLOW' ? 'success' : 'error'"
                variant="subtle"
                size="sm"
                class="cursor-pointer"
                :trailing-icon="grantFor(resource.id, action)!.whereClause ? 'i-lucide-filter' : undefined"
              >
                {{ grantFor(resource.id, action)!.effect }}
              </UBadge>
              <span
                v-else
                class="text-muted cursor-pointer"
              >—</span>
            </button>
            <span
              v-else
              class="text-dimmed"
            >·</span>
          </template>
          <template #actions-cell="{ row: { original: resource } }">
            <UPopover
              :open="rowActionsOpenFor === resource.id"
              :content="{ align: 'end' }"
              @update:open="(open: boolean) => setRowActionsOpen(resource.id, open)"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-label="t('users.roleEditor.rowActions', { name: resource.name })"
                :loading="runningRowActionFor === resource.id"
              />
              <template #content>
                <div
                  v-if="!pendingRowAction"
                  class="flex w-52 flex-col p-1"
                >
                  <UButton
                    v-for="rowAction in rowActionItems(resource)"
                    :key="rowAction.kind"
                    :icon="rowAction.icon"
                    :label="rowAction.label"
                    :color="rowAction.kind === 'clearAll' ? 'error' : 'neutral'"
                    variant="ghost"
                    size="sm"
                    class="justify-start"
                    :disabled="rowAction.disabled"
                    @click="pendingRowAction = rowAction.kind"
                  />
                </div>
                <div
                  v-else
                  class="flex w-72 flex-col gap-3 p-3"
                >
                  <p class="text-sm">
                    {{ rowActionDescription(resource, pendingRowAction) }}
                  </p>
                  <div class="flex justify-end gap-2">
                    <UButton
                      :label="t('common.back')"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      :disabled="runningRowActionFor === resource.id"
                      @click="pendingRowAction = null"
                    />
                    <UButton
                      :label="t('common.confirm')"
                      :color="pendingRowAction === 'clearAll' ? 'error' : 'primary'"
                      size="sm"
                      :loading="runningRowActionFor === resource.id"
                      @click="runRowAction(resource, pendingRowAction)"
                    />
                  </div>
                </div>
              </template>
            </UPopover>
          </template>
        </UTable>
      </div>

      <RoleAccessReviews
        v-else-if="section === 'reviews'"
        :role-id="roleId"
        :reminder="(role.reserved && role.adminAccess && !isWorkflowsRole(role)) || role.reviewRequired === true"
      />
      <!-- General: the role's own fields (RoleForm.vue), Save at the end as on a settings page. -->
      <div
        v-else-if="section === 'general'"
        class="mx-auto flex w-full max-w-3xl flex-col gap-8"
      >
        <SettingsSection :title="t('users.roleEditor.tabs.general')">
          <RoleForm
            ref="settingsForm"
            mode="edit"
            :role="role"
            @saved="onRoleSaved"
          />
          <div class="flex justify-end">
            <UButton
              :label="t('common.save')"
              :loading="settingsForm?.saving"
              :disabled="role.reserved"
              @click="settingsForm?.submit()"
            />
          </div>
        </SettingsSection>
      </div>
      <template v-else>
        <div
          v-if="!role.adminAccess"
          class="mx-auto w-full max-w-3xl"
        >
          <RoleManagersField :role-id="roleId" />
          <RoleIncompatibleField :role-id="roleId" />
        </div>
        <RoleUsersPanel
          :role-id="roleId"
          :role-name="role.name"
          :admin-role="role.reserved && role.adminAccess && !isWorkflowsRole(role)"
          :locked="isWorkflowsRole(role)"
        />
      </template>
    </template>
    <UEmpty
      v-else-if="rolePending"
      loading
      variant="naked"
      size="sm"
    />

    <RolePermissionEditor
      ref="editor"
      :role-id="roleId"
      @saved="refreshGrants"
    />

    <DuplicateRoleModal
      v-if="role"
      v-model:open="duplicateOpen"
      :role-id="role.id"
      :role-name="role.name"
      :delegated="false"
    />
    <UModal
      v-model:open="deleteOpen"
      :title="t('users.roleEditor.deleteTitle')"
      :description="t('users.roleEditor.deleteDescription')"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UCheckbox
            v-model="deleteConfirmed"
            :label="t('common.confirm')"
          />
          <div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              :label="t('common.delete')"
              color="error"
              :loading="deleting"
              :disabled="!deleteConfirmed"
              @click="deleteRole"
            />
          </div>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
