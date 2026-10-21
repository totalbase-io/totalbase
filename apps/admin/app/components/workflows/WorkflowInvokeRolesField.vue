<script setup lang="ts">
/**
 * The roles that may invoke a workflow (Workflows.md §12) - object access, as a DataView's or a
 * Dashboard's (Security.md §7): the same list (ObjectRolesList.vue), a switch per role, administrators
 * "Always". Shared by NewWorkflowModal.vue's creation wizard and the workflow's settings page
 * (pages/workflows/[id]/settings.vue), which persist it with `PUT /admin/api/workflows/:id/roles`.
 */
const roleIds = defineModel<string[]>({ default: () => [] })
const { data: allRoles } = useRoleOptions()
const roles = computed(() => allRoles.value ?? [])
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField
      :label="$t('workflows.workflowInvokeRolesField.rolesThatMayInvokeThis')"
      :description="$t('workflows.workflowInvokeRolesField.administratorsCanAlwaysInvokeAny')"
    >
      <ObjectRolesList
        v-model="roleIds"
        :roles="roles"
        class="mt-1"
      />
    </UFormField>
    <UAlert
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      :title="$t('workflows.workflowInvokeRolesField.onlyMattersForManualCron')"
      :description="$t('workflows.workflowInvokeRolesField.aDataEventTriggerNever')"
    />
  </div>
</template>
