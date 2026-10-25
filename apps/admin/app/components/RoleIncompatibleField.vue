<script setup lang="ts">
// Incompatible roles (Security.md §1.9): the roles nobody may hold together
// with this one - segregation of duties, whoever operates doesn't audit.
// Administrators only; applies at once. A pair some user already holds is
// refused: one of the two roles goes first.
const props = defineProps<{ roleId: string }>()

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const { data: allRoles } = useRoleOptions()
const roleOptions = computed(() => (allRoles.value ?? [])
  .filter(r => !r.reserved && r.id !== props.roleId)
  .map(r => ({ label: r.name, value: r.id })))

const roleIds = ref<string[]>([])
const saving = ref(false)
watch(() => props.roleId, async (id) => {
  try {
    roleIds.value = (await api.get<string[]>(`/roles/${id}/incompatible`)).data
  } catch (error) {
    notifyError(error, t('users.roleIncompatible.loadError'))
  }
}, { immediate: true })

async function save(next: string[]) {
  const previous = roleIds.value
  roleIds.value = next
  saving.value = true
  try {
    roleIds.value = (await api.put<string[]>(`/roles/${props.roleId}/incompatible`, { data: { roleIds: next } })).data
  } catch (error) {
    roleIds.value = previous
    notifyError(error, t('users.roleIncompatible.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UFormField
    :label="t('users.roleIncompatible.label')"
    :description="t('users.roleIncompatible.description')"
    class="mt-4"
  >
    <USelectMenu
      :model-value="roleIds"
      :items="roleOptions"
      value-key="value"
      multiple
      searchable
      :aria-label="t('users.roleIncompatible.label')"
      :loading="saving"
      class="w-full"
      @update:model-value="save"
    />
  </UFormField>
</template>
