<script setup lang="ts">
/**
 * See as (Specification_Security.md §8.4): an administrator picks a role, or a user, and the App opens as they see
 * it - their menu, their rows, their buttons - read-only. A user brings their own $USER (their rows by a row
 * filter); a role keeps the administrator's.
 */
import type { Role } from '~/types/permission'
import { isWorkflowsRole } from '~/types/security'
import { setViewAs } from '~/utils/view-as'

const open = defineModel<boolean>('open', { required: true })
/** Where the App opens - one DataView's or dashboard's page; the App's own by default. */
const props = defineProps<{ path?: string }>()
const { t } = useI18n()
const toast = useToast()
const adminApi = useAdminApi()
const rolesApi = useRolesApi()
const dataApi = useDataApi()

const kind = ref<'role' | 'user'>('user')
const roles = ref<Role[]>([])
const roleId = ref<string>()
const userId = ref<string>()
const userSearch = ref('')
const users = ref<{ label: string, description?: string, value: string }[]>([])
const starting = ref(false)

watch(open, async (isOpen) => {
  if (!isOpen) return
  roleId.value = undefined
  userId.value = undefined
  roles.value = await rolesApi.list()
  await searchUsers('')
}, { immediate: true })

const roleItems = computed(() => roles.value
  .filter(r => r.active && !r.adminAccess && !isWorkflowsRole(r))
  .map(r => ({ label: r.name, description: r.description ?? undefined, value: r.id })))

async function searchUsers(term: string) {
  const rows = (await dataApi.get<{ id: string, name: string | null, email: string }[]>(dataApi.resourcePath('totalbase', 'users'), {
    'fields': 'id,name,email',
    'where[active][_eq]': true,
    ...(term.trim() ? { search: term.trim() } : {}),
    'order_by': 'name',
    'limit': 20
  })).data
  users.value = rows.map(u => ({ label: u.name || u.email, description: u.name ? u.email : undefined, value: u.id }))
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(userSearch, (term) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void searchUsers(term), 250)
})

const targetId = computed(() => kind.value === 'role' ? roleId.value : userId.value)

async function start() {
  if (!targetId.value) return
  starting.value = true
  try {
    const { data } = await adminApi.post<{ kind: 'role' | 'user', id: string, name: string }>('/view-as', { data: { kind: kind.value, id: targetId.value } })
    setViewAs(data)
    // A fresh App - its menu, its DataViews and their rows - read as the target.
    window.location.assign(`${useRuntimeConfig().app.baseURL.replace(/\/$/, '')}${props.path ?? '/app'}`)
  } catch (error) {
    toast.add({ title: t('shell.viewAs.failed'), description: error instanceof Error ? error.message : undefined, color: 'error' })
    starting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('shell.viewAs.title')"
    :description="t('shell.viewAs.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <URadioGroup
          v-model="kind"
          orientation="horizontal"
          :items="[{ label: t('shell.viewAs.user'), value: 'user' }, { label: t('shell.viewAs.role'), value: 'role' }]"
        />
        <UFormField
          v-if="kind === 'user'"
          :label="t('shell.viewAs.user')"
          :description="t('shell.viewAs.userHelp')"
        >
          <USelectMenu
            v-model="userId"
            v-model:search-term="userSearch"
            :items="users"
            value-key="value"
            ignore-filter
            :aria-label="t('shell.viewAs.user')"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-else
          :label="t('shell.viewAs.role')"
          :description="t('shell.viewAs.roleHelp')"
        >
          <USelectMenu
            v-model="roleId"
            :items="roleItems"
            value-key="value"
            :aria-label="t('shell.viewAs.role')"
            class="w-full"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('shell.viewAs.start')"
          icon="i-lucide-eye"
          :disabled="!targetId"
          :loading="starting"
          @click="start"
        />
      </div>
    </template>
  </UModal>
</template>
