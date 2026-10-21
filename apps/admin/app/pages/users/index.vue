<script setup lang="ts">
// An administrator's Users table (Admin API: status and role filters,
// sign-in state); a delegated user's, through the Data API
// (Security.md §9.3).
const session = useSession()
</script>

<template>
  <UsersAdminList v-if="session.access.value === 'ADMIN'" />
  <UsersDelegatedList v-else />
</template>
