<script setup lang="ts">
/**
 * A role for a delegated user (pages/roles/[id].vue; Security.md §9.4):
 * its details and members, all through the Data API. They may
 * rename or delete a role they created, and assign it when they created it
 * or one of their roles manages it - the server's guardrails decide, this
 * only hides what their grants rule out. Never its permissions.
 */
import { roleIcon } from '~/types/permission'
import type { RoleMember } from '~/composables/useRolesApi'
import { useApiErrorMessage } from '~/utils/api-error-message'

const props = defineProps<{ roleId: string }>()

const session = useSession()
const rolesApi = useRolesApi()
const dataApi = useDataApi()
const directory = useUserDirectory()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const { data: role, pending, error, refresh } = await useAsyncData(`role-data-${props.roleId}`, () => rolesApi.get(props.roleId))

// created_by is absent when the caller may not read it - the server then decides.
const owned = computed(() => role.value?.createdBy === undefined || role.value.createdBy === session.admin.value?.id)
const canEdit = computed(() => owned.value && session.can('roles', 'UPDATE'))
const canDelete = computed(() => owned.value && session.can('roles', 'DELETE'))
const canSeeMembers = computed(() => session.can('assignments', 'READ'))
const canAdd = computed(() => session.canAssign(props.roleId, 'CREATE'))
const canRemove = computed(() => session.canAssign(props.roleId, 'DELETE'))

// --- Details / Delete ---
const detailsOpen = ref(false)
async function onSaved() {
  await Promise.all([refresh(), refreshNuxtData(['roles-all', 'role-options'])])
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
    await rolesApi.remove(props.roleId)
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

const menuItems = computed(() => [
  ...(canEdit.value ? [[{ label: t('users.roleEditor.detailsEllipsis'), icon: 'i-lucide-pencil', onSelect: () => { detailsOpen.value = true } }]] : []),
  ...(canDelete.value ? [[{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleteOpen.value = true } }]] : [])
])

// --- Members: one page at a time; a search narrows it to matching users. ---
const PAGE_SIZE = 50
const members = ref<RoleMember[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref<string | null>(null)
const search = ref('')
const debouncedSearch = useDebouncedRef(() => search.value.trim())

/** Ids of the users matching `term`, among those the caller may read - searched in every text column they may read (no `fields`: a search looks only at the text fields asked for, Data_API.md §3.5). */
async function matchingUserIds(term: string, limit: number): Promise<string[]> {
  const { data } = await dataApi.get<Array<{ id: string }>>(dataApi.resourcePath('totalbase', 'users'), { search: term, limit })
  return data.map(user => user.id)
}

async function loadMembers(reset: boolean) {
  if (!canSeeMembers.value) return
  loading.value = true
  loadError.value = null
  try {
    const userIds = debouncedSearch.value ? await matchingUserIds(debouncedSearch.value, 200) : undefined
    const page = userIds?.length === 0
      ? { members: [], total: 0 }
      : await rolesApi.listMembers(props.roleId, { offset: reset ? 0 : members.value.length, limit: PAGE_SIZE, userIds })
    members.value = reset ? page.members : [...members.value, ...page.members]
    total.value = page.total
    await directory.ensure(page.members.map(member => member.user))
  } catch (err) {
    loadError.value = errorMessage(err, t('users.roleDelegated.loadMembersError'))
  } finally {
    loading.value = false
  }
}
watch(debouncedSearch, () => loadMembers(true))
onMounted(() => loadMembers(true))

const removingId = ref<string | null>(null)
async function removeMember(member: RoleMember) {
  removingId.value = member.assignment
  try {
    await rolesApi.removeMember(member.assignment)
    toast.add({ title: t('users.roleDelegated.removed', { role: role.value?.name }), color: 'success' })
    await loadMembers(true)
  } catch (err) {
    notifyError(err, t('users.roleDelegated.removeError'))
  } finally {
    removingId.value = null
  }
}

// --- Add an existing user: remote search over the users the caller may read. ---
const addSearch = ref('')
const addItems = ref<Array<{ label: string, description?: string, value: string }>>([])
const addLoading = ref(false)
let addTimer: ReturnType<typeof setTimeout> | undefined
watch(addSearch, (value) => {
  if (!canAdd.value) return
  clearTimeout(addTimer)
  addTimer = setTimeout(async () => {
    addLoading.value = true
    try {
      const { data } = await dataApi.get<Array<{ id: string, name?: string | null, email?: string | null }>>(
        dataApi.resourcePath('totalbase', 'users'),
        { limit: 10, ...(value.trim() && { search: value.trim() }) }
      )
      const current = new Set(members.value.map(member => member.user))
      addItems.value = data.filter(user => !current.has(user.id)).map(user => ({
        label: user.name || user.email || user.id,
        description: user.name ? (user.email ?? undefined) : undefined,
        value: user.id
      }))
    } catch {
      addItems.value = []
    } finally {
      addLoading.value = false
    }
  }, 250)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(addTimer))

const adding = ref(false)
const addSelection = ref<(typeof addItems.value)[number] | undefined>(undefined)
async function addMember(item: { label: string, value: string } | undefined) {
  if (!item) return
  adding.value = true
  try {
    await rolesApi.addMember(props.roleId, item.value)
    toast.add({ title: t('users.roleDelegated.added', { user: item.label, role: role.value?.name }), color: 'success' })
    addSearch.value = ''
    await loadMembers(true)
  } catch (err) {
    notifyError(err, t('users.roleDelegated.addError'))
  } finally {
    adding.value = false
    addSelection.value = undefined
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
        :menu="role ? menuItems : undefined"
      >
        <UBadge
          v-if="role && !role.active"
          :label="t('common.inactive')"
          color="warning"
          variant="subtle"
          class="page-header__tall px-2.5"
        />
      </PageHeader>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="errorMessage(error, t('users.roleDelegated.loadError'))"
    />
    <UEmpty
      v-else-if="pending"
      loading
      variant="naked"
      size="sm"
    />
    <p
      v-else-if="!role"
      class="py-12 text-center text-sm text-muted"
    >
      {{ t('users.roleDelegated.notFound') }}
    </p>
    <div
      v-else-if="canSeeMembers"
      class="mx-auto flex w-full max-w-2xl flex-col gap-3 pt-4"
    >
      <i18n-t
        keypath="users.roleDelegated.memberCount"
        :plural="total"
        tag="p"
        class="text-sm text-muted"
      >
        <template #count>
          {{ total }}
        </template>
        <template #role>
          <span class="font-medium">{{ role.name }}</span>
        </template>
      </i18n-t>
      <USelectMenu
        v-if="canAdd"
        v-model="addSelection"
        v-model:search-term="addSearch"
        :aria-label="t('users.roleDelegated.addUser')"
        :items="addItems"
        :loading="addLoading || adding"
        ignore-filter
        icon="i-lucide-user-plus"
        :placeholder="t('users.roleDelegated.addUser')"
        class="w-full"
        @update:model-value="addMember"
      />
      <UInput
        v-model="search"
        :aria-label="t('users.roleDelegated.searchMembers')"
        icon="i-lucide-search"
        :placeholder="t('users.roleDelegated.searchMembers')"
        class="w-full"
      />
      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        :title="loadError"
      />
      <p
        v-else-if="!loading && members.length === 0"
        class="py-8 text-center text-sm text-muted"
      >
        {{ debouncedSearch ? t('users.roleDelegated.noMatch', { search: debouncedSearch }) : t('users.roleDelegated.noMembers') }}
      </p>
      <ul
        v-else
        class="divide-y divide-default rounded-lg border border-default"
      >
        <li
          v-for="member in members"
          :key="member.assignment"
          class="flex items-center justify-between gap-3 px-3 py-2"
        >
          <UUser
            :name="directory.label(member.user)"
            :description="directory.email(member.user) !== directory.label(member.user) ? (directory.email(member.user) ?? undefined) : undefined"
            :avatar="{ src: directory.avatar(member.user) ?? undefined, alt: directory.label(member.user) }"
            size="sm"
            class="min-w-0"
          />
          <UButton
            v-if="canRemove"
            icon="i-lucide-user-minus"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="t('users.roleDelegated.removeLabel', { user: directory.label(member.user), role: role.name })"
            :disabled="removingId !== null && removingId !== member.assignment"
            :loading="removingId === member.assignment"
            @click="removeMember(member)"
          />
        </li>
      </ul>
      <div
        v-if="members.length < total"
        class="flex justify-center"
      >
        <UButton
          :label="t('users.roleDelegated.loadMore')"
          color="neutral"
          variant="outline"
          :loading="loading"
          @click="loadMembers(false)"
        />
      </div>
    </div>

    <RoleFormModal
      v-model:open="detailsOpen"
      mode="edit"
      :role="role"
      @saved="onSaved"
    />

    <UModal
      v-model:open="deleteOpen"
      :title="t('users.roleEditor.deleteTitle')"
    >
      <template #body>
        <i18n-t
          keypath="users.roleDelegated.deleteBody"
          tag="p"
          class="text-sm text-muted"
        >
          <template #role>
            <span class="font-medium text-default">{{ role?.name }}</span>
          </template>
        </i18n-t>
      </template>
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
