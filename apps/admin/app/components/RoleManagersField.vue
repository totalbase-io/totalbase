<script setup lang="ts">
// Role managers (Specification_Security.md §9.4): the roles whose
// members may assign this one to users - how a delegated user hands out a
// role they didn't create. Administrators only; applies at once.
const props = defineProps<{ roleId: string }>()

const api = useAdminApi()
const rolesApi = useRolesApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const { data: allRoles } = useRoleOptions()
// A role with admin access already assigns everything; a role never manages itself.
const roleOptions = computed(() => (allRoles.value ?? [])
  .filter(r => !r.adminAccess && r.id !== props.roleId)
  .map(r => ({ label: r.name, value: r.id })))

const managerIds = ref<string[]>([])
const saving = ref(false)
watch(() => props.roleId, async (id) => {
  try {
    managerIds.value = await rolesApi.managers(id)
  } catch (error) {
    notifyError(error, t('users.roleManagers.loadError'))
  }
}, { immediate: true })

async function save(next: string[]) {
  const previous = managerIds.value
  managerIds.value = next
  saving.value = true
  try {
    managerIds.value = (await api.put<string[]>(`/roles/${props.roleId}/managers`, { data: { roleIds: next } })).data
  } catch (error) {
    managerIds.value = previous
    notifyError(error, t('users.roleManagers.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UFormField
    :label="t('users.roleManagers.label')"
    :description="t('users.roleManagers.description')"
  >
    <USelectMenu
      :model-value="managerIds"
      :items="roleOptions"
      value-key="value"
      multiple
      searchable
      :aria-label="t('users.roleManagers.label')"
      :loading="saving"
      class="w-full"
      @update:model-value="save"
    />
  </UFormField>
</template>
