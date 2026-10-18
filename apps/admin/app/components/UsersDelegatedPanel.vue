<script setup lang="ts">
/**
 * The Users rail group's panel for a delegated user (layouts/default.vue):
 * Invite, when they may create users, and the list. No status/role counts -
 * those are an administrator's summary of every account.
 */
import type { AdminUser } from '~/types/security'

const route = useRoute()
const session = useSession()
const inviteOpen = ref(false)
const { t } = useI18n()

async function onInvited(user: AdminUser) {
  await refreshUsersData()
  await navigateTo(`/users/${user.id}`)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <UButton
      v-if="session.can('users', 'CREATE')"
      icon="i-lucide-mail-plus"
      :label="t('users.userInvite.title')"
      block
      @click="inviteOpen = true"
    />
    <NuxtLink
      to="/users"
      class="flex w-full min-w-0 items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-elevated hover:text-highlighted"
      :class="route.path === '/users' ? 'bg-elevated text-highlighted' : 'text-default'"
    >
      <UIcon
        name="i-lucide-users"
        class="size-4 shrink-0 text-muted"
      />
      <span class="truncate">{{ t('users.usersDelegated.allUsers') }}</span>
    </NuxtLink>
    <UserInviteModal
      v-model:open="inviteOpen"
      @created="onInvited"
    />
  </div>
</template>
