<script setup lang="ts">
// Incompatible roles (Security.md §1.9): the roles nobody may hold together
// with this one - segregation of duties, whoever operates doesn't audit.
// Administrators only; saved with the role page's Save. A pair some user already holds is
// refused: one of the two roles goes first.
const props = defineProps<{ roleId: string }>()
const roleIds = defineModel<string[]>({ required: true })

const { t } = useI18n()
const { data: allRoles } = useRoleOptions()
const roleOptions = computed(() => (allRoles.value ?? [])
  .filter(r => !r.reserved && r.id !== props.roleId)
  .map(r => ({ label: r.name, value: r.id })))
</script>

<template>
  <UFormField
    :label="t('users.roleIncompatible.label')"
    :description="t('users.roleIncompatible.description')"
  >
    <USelectMenu
      :model-value="roleIds"
      :items="roleOptions"
      value-key="value"
      multiple
      searchable
      :aria-label="t('users.roleIncompatible.label')"
      class="w-full"
      @update:model-value="(next: string[]) => { roleIds = next }"
    />
  </UFormField>
</template>
