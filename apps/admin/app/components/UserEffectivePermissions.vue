<script setup lang="ts">
/**
 * A user's effective permissions - the computed, read-only union of every
 * active role assigned to them (DENY beats ALLOW beats no grant). The
 * Permissions tab of pages/users/[id].vue - its own PageShell nested in
 * that page's body (toolbar fixed, table header sticky).
 *
 * An ALLOW is not always "everything": a cell says when it's limited to
 * some rows (the grants' row filters, OR-combined) or carries payload
 * checks, and its popover shows which role brings each. A user holding an
 * admin-access role bypasses permissions entirely - the tab says so
 * instead of drawing a matrix of ALLOWs.
 */
import type { TableColumn } from '@nuxt/ui'
import type { RoleSummary } from '~/types/security'
import type { Resource } from '~/types/resource'
import { ACTIONS_BY_RESOURCE_TYPE, type PermissionAction } from '~/types/permission'
import type { BulkActionDecision, EffectiveResourceEntry } from '~/types/effective-permission'

const props = defineProps<{ userId: string }>()
const userId = props.userId
const api = useAdminApi()
const { t } = useI18n()

const ALL_ACTIONS: PermissionAction[] = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE']
const MATRIX_COLUMNS = computed<TableColumn<Resource>[]>(() => [
  { id: 'resource', header: t('users.roleEditor.resource') },
  ...ALL_ACTIONS.map(action => ({ id: action, header: action, meta: { class: { th: 'text-center', td: 'text-center' } } }))
])

// meta.roles: the user's active roles the union was computed from.
const { data: effective, pending: effectivePending, error: effectiveError, refresh: refreshEffective } = await useAsyncData(
  `user-${userId}-effective-permissions`,
  () => api.get<EffectiveResourceEntry[]>(`/users/${userId}/effective-permissions`),
  { default: () => ({ data: [] as EffectiveResourceEntry[], meta: {} as Record<string, unknown> }) }
)
const entries = computed(() => effective.value?.data ?? [])
const activeRoleIds = computed(() => (effective.value?.meta?.roles as string[] | undefined) ?? [])

const { resources, refresh: refreshResources } = useResourcesList()

const { data: roles } = await useRoleOptions()
const roleName = (id: string) => (roles.value ?? []).find((r: RoleSummary) => r.id === id)?.name ?? id

/** The admin-access role(s) that make this user bypass permissions, if any. */
const bypassRoles = computed(() => (roles.value ?? []).filter(r => r.adminAccess && activeRoleIds.value.includes(r.id)))

// Recomputes the union from scratch - a role's grants can change from
// another tab (or another admin) while this read-only view sits open.
const refreshing = ref(false)
async function refreshAll() {
  refreshing.value = true
  try {
    await Promise.all([refreshEffective(), refreshResources()])
  } finally {
    refreshing.value = false
  }
}

const resourceById = computed(() => new Map((resources.value ?? []).map(r => [r.id, r])))
const entryByResource = computed(() => new Map(entries.value.map(e => [e.resource, e])))

// TABLE, then VIEW, then FUNCTION, then name asc within each - same
// ordering as ResourcesBrowser.vue's sortedRows.
const TYPE_ORDER: Record<Resource['type'], number> = { TABLE: 0, VIEW: 1, FUNCTION: 2 }

const search = ref('')
/** Most users are granted a handful of resources - the rest would be rows of "—". */
const onlyGranted = ref(true)

function hasAnyDecision(resourceId: string) {
  const entry = entryByResource.value.get(resourceId)
  return !!entry && ALL_ACTIONS.some(a => entry.actions[a].decision !== 'UNDEFINED')
}

const rows = computed(() => {
  const term = search.value.trim().toLowerCase()
  return entries.value
    .map(e => resourceById.value.get(e.resource))
    .filter((r): r is Resource => r !== undefined)
    .filter(r => !onlyGranted.value || hasAnyDecision(r.id))
    .filter(r => !term || r.name.toLowerCase().includes(term) || r.schema.toLowerCase().includes(term))
    .sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || a.name.localeCompare(b.name))
})

function isApplicable(type: Resource['type'], action: PermissionAction) {
  return (ACTIONS_BY_RESOURCE_TYPE[type] as PermissionAction[]).includes(action)
}

// DELETE/EXECUTE have no column concept - a resource is either deleted/
// executed wholesale or not at all, so the popover's Fields line only
// makes sense for CREATE/READ/UPDATE.
function hasFields(action: PermissionAction) {
  return action === 'CREATE' || action === 'READ' || action === 'UPDATE'
}

const UNDEFINED_DECISION: BulkActionDecision = { decision: 'UNDEFINED', roles: [] }
function decisionFor(resourceId: string, action: PermissionAction): BulkActionDecision {
  return entryByResource.value.get(resourceId)?.actions[action] ?? UNDEFINED_DECISION
}

const compact = (value: unknown) => JSON.stringify(value)
</script>

<template>
  <PageShell>
    <template #toolbar>
      <div class="flex flex-wrap items-center gap-3">
        <p class="min-w-0 flex-1 text-sm text-muted">
          {{ t('users.effective.intro') }}
        </p>
        <template v-if="!bypassRoles.length">
          <USwitch
            v-model="onlyGranted"
            :label="t('users.effective.onlyGranted')"
          />
          <UInput
            v-model="search"
            :aria-label="t('users.roleEditor.filterResources')"
            icon="i-lucide-search"
            :placeholder="t('users.roleEditor.filterResources')"
            class="w-full sm:w-56"
          />
        </template>
        <UTooltip :text="t('common.refresh')">
          <UButton
            :aria-label="t('common.refresh')"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            square
            :loading="refreshing"
            @click="refreshAll"
          />
        </UTooltip>
      </div>
    </template>

    <UAlert
      v-if="effectiveError"
      color="error"
      variant="subtle"
      :title="effectiveError.message"
    />

    <UEmpty
      v-else-if="effectivePending"
      loading
      variant="naked"
      size="sm"
    />

    <UAlert
      v-else-if="bypassRoles.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-shield-alert"
      :title="t('users.effective.fullAccess', { roles: bypassRoles.map(r => r.name).join(', ') })"
      :description="t('users.effective.fullAccessDescription')"
    />

    <div
      v-else-if="rows.length === 0"
      class="flex flex-col items-center gap-1 rounded-lg border border-dashed border-default px-4 py-10 text-center"
    >
      <UIcon
        name="i-lucide-list-checks"
        class="size-6 text-dimmed"
      />
      <p class="text-sm font-medium text-highlighted">
        {{ search ? t('users.effective.noMatch', { search }) : t('users.effective.noPermissions') }}
      </p>
      <p
        v-if="!search"
        class="text-sm text-muted"
      >
        {{ onlyGranted ? t('users.effective.noneGranted') : t('users.effective.noneGrantedHere') }}
      </p>
    </div>

    <UTable
      v-else
      sticky
      :data="rows"
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
        <UPopover v-if="isApplicable(resource.type, action)">
          <button
            v-if="decisionFor(resource.id, action).decision !== 'UNDEFINED'"
            type="button"
            class="inline-flex items-center gap-1"
          >
            <UBadge
              :color="decisionFor(resource.id, action).decision === 'ALLOW' ? 'success' : 'error'"
              variant="subtle"
              size="sm"
            >
              {{ decisionFor(resource.id, action).decision }}
            </UBadge>
            <UIcon
              v-if="decisionFor(resource.id, action).rowFilters"
              name="i-lucide-filter"
              class="size-3.5 text-warning"
              :aria-label="t('users.effective.someRows')"
            />
            <UIcon
              v-if="decisionFor(resource.id, action).payloadChecks"
              name="i-lucide-list-checks"
              class="size-3.5 text-muted"
              :aria-label="t('users.permissionEditor.tabs.payloadChecks')"
            />
          </button>
          <button
            v-else
            type="button"
            class="text-muted"
          >
            —
          </button>
          <template #content>
            <div class="flex w-80 flex-col gap-2 p-3">
              <p class="text-xs text-muted">
                <span class="text-highlighted">{{ resource.schema }}.{{ resource.name }}</span> — {{ action }}
              </p>
              <UBadge
                :color="decisionFor(resource.id, action).decision === 'ALLOW' ? 'success' : decisionFor(resource.id, action).decision === 'DENY' ? 'error' : 'neutral'"
                variant="subtle"
                class="w-fit"
              >
                {{ decisionFor(resource.id, action).decision }}
              </UBadge>
              <p
                v-if="decisionFor(resource.id, action).roles.length === 0"
                class="text-sm text-muted"
              >
                {{ t('users.effective.noRole') }}
              </p>
              <div
                v-else
                class="flex flex-col gap-1"
              >
                <p class="text-sm text-muted">
                  {{ decisionFor(resource.id, action).decision === 'DENY' ? t('users.effective.denyWins') : t('users.effective.grantedBy') }}
                </p>
                <ul class="flex flex-col gap-1">
                  <li
                    v-for="roleId in decisionFor(resource.id, action).roles"
                    :key="roleId"
                    class="text-sm font-medium"
                  >
                    {{ roleName(roleId) }}
                  </li>
                </ul>
                <p
                  v-if="decisionFor(resource.id, action).ceiling?.length"
                  class="text-xs text-muted"
                >
                  {{ t('users.effective.limitedBy', { roles: decisionFor(resource.id, action).ceiling!.map(roleName).join(', ') }) }}
                </p>
              </div>

              <template v-if="decisionFor(resource.id, action).decision === 'ALLOW'">
                <div class="flex flex-col gap-1 border-t border-default pt-2">
                  <p class="text-xs font-medium text-highlighted">
                    {{ t('users.effective.rows') }}
                  </p>
                  <p
                    v-if="!decisionFor(resource.id, action).rowFilters"
                    class="text-xs text-muted"
                  >
                    {{ t('users.effective.everyRow') }}
                  </p>
                  <template v-else>
                    <p class="text-xs text-muted">
                      {{ decisionFor(resource.id, action).rowFilters!.length > 1 ? t('users.effective.onlyRowsAny') : t('users.effective.onlyRows') }}
                    </p>
                    <div
                      v-for="(filter, i) in decisionFor(resource.id, action).rowFilters"
                      :key="i"
                      class="flex flex-col gap-0.5"
                    >
                      <span class="text-xs text-muted">{{ roleName(filter.role) }}</span>
                      <code class="rounded bg-elevated px-2 py-1 text-xs break-all">{{ compact(filter.where) }}</code>
                    </div>
                  </template>
                </div>

                <div
                  v-if="decisionFor(resource.id, action).payloadChecks"
                  class="flex flex-col gap-1 border-t border-default pt-2"
                >
                  <p class="text-xs font-medium text-highlighted">
                    {{ t('users.effective.payloadChecks') }}
                  </p>
                  <div
                    v-for="(check, i) in decisionFor(resource.id, action).payloadChecks"
                    :key="i"
                    class="flex flex-col gap-0.5"
                  >
                    <span class="text-xs text-muted">{{ check.label ?? t('users.effective.unnamedCheck') }} · {{ roleName(check.role) }}</span>
                    <code class="rounded bg-elevated px-2 py-1 text-xs break-all">{{ compact(check.rule) }}</code>
                  </div>
                </div>

                <p
                  v-if="hasFields(action) && decisionFor(resource.id, action).fields !== undefined"
                  class="border-t border-default pt-2 text-xs text-muted"
                >
                  {{ t('users.permissionEditor.fields', { fields: decisionFor(resource.id, action).fields!.length > 0 ? decisionFor(resource.id, action).fields!.join(', ') : t('users.effective.noneGrantedFields') }) }}
                </p>
              </template>
            </div>
          </template>
        </UPopover>
        <span
          v-else
          class="text-dimmed"
        >·</span>
      </template>
    </UTable>
  </PageShell>
</template>
