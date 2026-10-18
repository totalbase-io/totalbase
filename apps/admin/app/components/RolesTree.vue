<script setup lang="ts">
/**
 * The Roles rail group's own nav panel (layouts/default.vue's aside,
 * `activeGroupKey === 'roles'`) - same "New button, search, list, leaf
 * click jumps straight to its own editor page" pattern TemplatesTree.vue
 * uses. One flat list, deliberately not grouped by access level: roles
 * are few, and a single alphabetical list is faster to scan. The reserved
 * Administrators role is pinned first.
 *
 * Creation lives in RoleFormModal.vue, opened from here; on success the
 * new role opens in its editor. No per-row actions - activate/deactivate
 * and delete live in the editor's own header menu, same call
 * TemplatesTree.vue made.
 */
import type { Role } from '~/types/permission'

const route = useRoute()
const session = useSession()
const { t } = useI18n()

const { data: roles, refresh, error } = await useRoles()

const search = ref('')
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return (roles.value ?? [])
    .filter(r => !query || r.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.reserved) - Number(a.reserved) || a.name.localeCompare(b.name))
})

const selectedId = computed(() => route.params.id as string | undefined)

const open = ref(false)

async function onSaved(role: Role) {
  // A delegated user may assign the role they just created - re-read what they may assign.
  await Promise.all([refresh(), refreshNuxtData('role-options'), session.access.value === 'ADMIN' ? undefined : session.refreshProfile()])
  await navigateTo(`/roles/${role.id}`)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UButton
      v-if="session.can('roles', 'CREATE')"
      icon="i-lucide-plus"
      :label="t('users.roleForm.newTitle')"
      block
      @click="open = true"
    />
    <UInput
      v-model="search"
      icon="i-lucide-search"
      :aria-label="t('users.rolesTree.search')"
      :placeholder="t('users.rolesTree.searchPlaceholder')"
      class="w-full"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('users.dataviewRoles.loadError')"
    />
    <section v-else>
      <div class="flex w-full items-center pb-2 text-xs font-medium uppercase tracking-wide text-muted">
        <span>{{ t('common.roles') }}</span>
        <span class="ms-auto text-xs font-normal">{{ filtered.length }}</span>
      </div>
      <div class="flex flex-col">
        <button
          v-for="role in filtered"
          :key="role.id"
          type="button"
          class="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-elevated hover:text-highlighted"
          :class="role.id === selectedId ? 'bg-elevated text-highlighted' : 'text-default'"
          @click="navigateTo(`/roles/${role.id}`)"
        >
          <RoleBadge :role="role" />
          <span
            class="truncate"
            :class="role.active ? undefined : 'text-muted line-through'"
          >{{ role.name }}</span>
          <UIcon
            v-if="role.reserved"
            name="i-lucide-lock"
            class="ms-auto size-3.5 shrink-0 text-muted"
          />
        </button>
        <p
          v-if="filtered.length === 0"
          class="px-3 py-1 text-xs text-muted"
        >
          {{ search.trim() ? t('users.rolesTree.noMatches') : t('users.rolesTree.noneYet') }}
        </p>
      </div>
    </section>

    <RoleFormModal
      v-model:open="open"
      mode="create"
      @saved="onSaved"
    />
  </div>
</template>
