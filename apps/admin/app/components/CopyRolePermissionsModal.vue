<script setup lang="ts">
/**
 * Copy from role… (a role's Permissions toolbar): another role's grants written on this one - POST
 * /roles/:id/permissions/copy (Security.md §5.4), one transaction. Added by default (the role's own grant on a
 * clash is kept), or replacing its grants after a Confirm. The server leaves out what this role's parent can't
 * give; the toast says what was copied, kept and left out. Never from itself, Administrators or Workflows.
 */
import type { Permission } from '~/types/permission'

const props = defineProps<{
  roleId: string
  /** This role's grants now - how many a replace removes. */
  ownCount: number
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ copied: [] }>()

interface CopiedGrant { resource: string, action: string }
interface CopyResult { copied: CopiedGrant[], kept: CopiedGrant[], beyondCeiling: CopiedGrant[] }

const { t } = useI18n()
const api = useAdminApi()
const rolesApi = useRolesApi()
const toast = useToast()
const notifyError = useErrorToast()
const { data: roles } = useRoles()

const from = ref<string | undefined>(undefined)
const mode = ref<'ADD' | 'REPLACE'>('ADD')
const confirmed = ref(false)
const copying = ref(false)
watch(open, (isOpen) => {
  if (!isOpen) return
  from.value = undefined
  mode.value = 'ADD'
  confirmed.value = false
})

const fromOptions = computed(() => (roles.value ?? [])
  .filter(role => role.id !== props.roleId && !role.reserved && !role.adminAccess)
  .map(role => ({ value: role.id, label: role.name, description: role.description ?? undefined })))
const modeItems = computed(() => [
  { value: 'ADD', label: t('users.copyPermissions.add'), description: t('users.copyPermissions.addHelp') },
  { value: 'REPLACE', label: t('users.copyPermissions.replace'), description: t('users.copyPermissions.replaceHelp', { n: props.ownCount }, props.ownCount) }
])

// What the chosen role has - so the copy isn't blind.
const sourceGrants = ref<Permission[] | null>(null)
watch(from, async (id) => {
  sourceGrants.value = null
  if (!id) return
  try {
    const grants = await rolesApi.permissions(id)
    if (from.value === id) sourceGrants.value = grants
  } catch (err) {
    notifyError(err, t('users.copyPermissions.loadError'))
  }
})
const sourceSummary = computed(() => {
  const grants = sourceGrants.value
  if (!grants) return undefined
  if (grants.length === 0) return t('users.copyPermissions.none')
  const resources = new Set(grants.map(g => g.resource)).size
  const filtered = grants.filter(g => g.whereClause).length
  return [
    t('users.copyPermissions.grants', { n: grants.length }, grants.length),
    t('users.copyPermissions.resources', { n: resources }, resources),
    ...(filtered > 0 ? [t('users.copyPermissions.filtered', { n: filtered }, filtered)] : [])
  ].join(' · ')
})

const canCopy = computed(() => !!from.value && (sourceGrants.value?.length ?? 0) > 0 && (mode.value === 'ADD' || confirmed.value))
const list = (grants: CopiedGrant[]) => grants.map(g => `${g.resource} ${g.action}`).join(', ')

async function copy() {
  if (!canCopy.value) return
  copying.value = true
  try {
    const { data } = await api.post<CopyResult>(`/roles/${props.roleId}/permissions/copy`, { data: { from: from.value, replace: mode.value === 'REPLACE' } })
    toast.add({
      title: t('users.copyPermissions.done', { n: data.copied.length }, data.copied.length),
      description: [
        data.kept.length > 0 ? t('users.copyPermissions.kept', { grants: list(data.kept) }) : '',
        data.beyondCeiling.length > 0 ? t('users.copyPermissions.beyondCeiling', { grants: list(data.beyondCeiling) }) : ''
      ].filter(Boolean).join(' ') || undefined,
      color: data.beyondCeiling.length > 0 ? 'warning' : 'success'
    })
    open.value = false
    emit('copied')
  } catch (err) {
    notifyError(err, t('users.copyPermissions.error'))
  } finally {
    copying.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('users.copyPermissions.title')"
    :description="t('users.copyPermissions.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('users.copyPermissions.from')"
          :help="sourceSummary"
        >
          <USelectMenu
            v-model="from"
            :items="fromOptions"
            value-key="value"
            :search-input="{ placeholder: t('common.search') }"
            class="w-full"
          />
        </UFormField>
        <URadioGroup
          v-model="mode"
          :items="modeItems"
          :aria-label="t('users.copyPermissions.mode')"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UCheckbox
          v-if="mode === 'REPLACE'"
          v-model="confirmed"
          :label="t('common.confirm')"
        />
        <span v-else />
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="copying"
            @click="open = false"
          />
          <UButton
            :label="t('users.copyPermissions.copy')"
            :color="mode === 'REPLACE' ? 'error' : 'primary'"
            :loading="copying"
            :disabled="!canCopy"
            @click="copy"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
