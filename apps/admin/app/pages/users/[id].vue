<script setup lang="ts">
// An administrator edits the whole account (Admin API); a delegated user
// its name, status and the roles they may assign, and sends it links
// (Security.md §9.3, §9.4).
const route = useRoute()
const session = useSession()
const userId = computed(() => route.params.id as string)
</script>

<template>
  <UserAdminEditor
    v-if="session.access.value === 'ADMIN'"
    :key="userId"
  />
  <UserDelegatedEditor
    v-else
    :key="userId"
    :user-id="userId"
  />
</template>
