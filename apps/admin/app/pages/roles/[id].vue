<script setup lang="ts">
// An administrator edits the whole role (permissions, access, managers);
// a delegated user sees its details and members (Specification_Security.md §9.4).
const route = useRoute()
const session = useSession()
const roleId = computed(() => route.params.id as string)
</script>

<template>
  <RoleAdminEditor
    v-if="session.access.value === 'ADMIN'"
    :key="roleId"
    :role-id="roleId"
  />
  <RoleDelegatedEditor
    v-else
    :key="roleId"
    :role-id="roleId"
  />
</template>
