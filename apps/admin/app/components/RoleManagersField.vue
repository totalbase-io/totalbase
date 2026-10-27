<script setup lang="ts">
// Role managers (Security.md §9.4): the roles whose
// members may assign this one to users - how a delegated user hands out a
// role they didn't create. Administrators only; saved with the role page's Save.
const managerIds = defineModel<string[]>({ required: true })

const { t } = useI18n()
const { data: allRoles } = useRoleOptions()
// A role with admin access already assigns everything. The role itself is offered: its members then add one
// another - "Site managers" adding another site manager.
const roleOptions = computed(() => (allRoles.value ?? [])
  .filter(r => !r.adminAccess)
  .map(r => ({ label: r.name, value: r.id })))
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
      class="w-full"
      @update:model-value="(next: string[]) => { managerIds = next }"
    />
  </UFormField>
</template>
