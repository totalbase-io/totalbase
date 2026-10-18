<script setup lang="ts">
/**
 * Which roles open an object - a DataView, a Dashboard (Specification_Security.md §7.1): a switch per role, as a
 * role's members are listed. Object access only, never data. Administrators always see it - a fixed "Always". With
 * `access` (a DataView over a table), each role says what it may do there, trimmed by the DataView's Allow, and
 * warns when it can't read it. Its host decides when a change is saved (at once in Settings, on create in the wizard).
 */
import type { RoleSummary } from '~/types/security'

export interface RoleSourceAccess { read: boolean, create: boolean, update: boolean, delete: boolean }

const roleIds = defineModel<string[]>({ required: true })
const props = defineProps<{
  roles: RoleSummary[]
  /** What each role may do on the source table, by role id - absent: no source, or not known yet. */
  access?: Record<string, RoleSourceAccess>
  /** The DataView's Allow - what it lets its viewers do, never more than their permissions. */
  allow?: readonly string[]
  /** The source's name, for the warnings. */
  sourceName?: string
  /** Allow's own tab, linked from a "taken by Allow" note. */
  allowLink?: string
  disabled?: boolean
}>()

const { t } = useI18n()
const search = ref('')
const MANY = 10
const admins = computed(() => props.roles.filter(r => r.adminAccess))
const others = computed(() => props.roles.filter(r => !r.adminAccess))
const shown = computed(() => {
  const term = search.value.trim().toLowerCase()
  return term ? others.value.filter(r => r.name.toLowerCase().includes(term)) : others.value
})
function toggle(id: string, on: boolean) {
  roleIds.value = on ? [...new Set([...roleIds.value, id])] : roleIds.value.filter(r => r !== id)
}
const setAll = (on: boolean) => {
  roleIds.value = on ? [...new Set([...roleIds.value, ...shown.value.filter(r => r.active).map(r => r.id)])] : roleIds.value.filter(id => !shown.value.some(r => r.id === id))
}

/** "Read · Create · Update" - what the role may do there; what Allow takes away, said apart. */
const ACTIONS = ['read', 'create', 'update', 'delete'] as const
function summary(id: string): { can: string, taken: string[] } | null {
  const access = props.access?.[id]
  if (!access) return null
  const can = ACTIONS.filter(a => access[a] && (a === 'read' || !props.allow || props.allow.includes(a)))
  const taken = ACTIONS.filter(a => a !== 'read' && access[a] && props.allow && !props.allow.includes(a))
  return { can: can.map(a => t(`users.objectRoles.actions.${a}`)).join(' · '), taken: taken.map(a => t(`users.objectRoles.actions.${a}`)) }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-if="others.length > MANY"
      class="flex items-center gap-2"
    >
      <UInput
        v-model="search"
        icon="i-lucide-search"
        :placeholder="t('users.objectRoles.search')"
        :aria-label="t('users.objectRoles.search')"
        class="min-w-0 flex-1"
      />
      <UButton
        :label="t('users.objectRoles.all')"
        color="neutral"
        variant="outline"
        :disabled="disabled"
        @click="setAll(true)"
      />
      <UButton
        :label="t('users.objectRoles.none')"
        color="neutral"
        variant="outline"
        :disabled="disabled"
        @click="setAll(false)"
      />
    </div>

    <ul class="divide-y divide-default rounded-md border border-default">
      <li
        v-for="role in admins"
        :key="role.id"
        class="flex items-center justify-between gap-3 px-3 py-2"
      >
        <div class="min-w-0">
          <p class="text-sm font-medium">
            {{ role.name }}
          </p>
          <p class="text-xs text-muted">
            {{ t('users.objectRoles.adminsHelp') }}
          </p>
        </div>
        <UBadge
          :label="t('users.objectRoles.always')"
          color="neutral"
          variant="subtle"
        />
      </li>
      <li
        v-for="role in shown"
        :key="role.id"
        class="flex items-center justify-between gap-3 px-3 py-2"
        :class="role.active ? undefined : 'opacity-60'"
      >
        <div class="min-w-0">
          <p class="flex items-center gap-2 text-sm font-medium">
            {{ role.name }}
            <UBadge
              v-if="!role.active"
              :label="t('users.objectRoles.inactive')"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </p>
          <template v-if="summary(role.id)">
            <p
              v-if="summary(role.id)!.can"
              class="text-xs text-muted"
            >
              {{ summary(role.id)!.can }}
              <template v-if="summary(role.id)!.taken.length">
                ·
                <NuxtLink
                  v-if="allowLink"
                  :to="allowLink"
                  class="underline"
                >{{ t('users.objectRoles.takenByAllow', { actions: summary(role.id)!.taken.join(', ') }) }}</NuxtLink>
                <span v-else>{{ t('users.objectRoles.takenByAllow', { actions: summary(role.id)!.taken.join(', ') }) }}</span>
              </template>
            </p>
            <p
              v-if="!access![role.id]!.read"
              class="flex items-center gap-1 text-xs text-warning"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-3.5 shrink-0"
              />
              <span>{{ t('users.objectRoles.noRead', { source: sourceName ?? '' }) }}</span>
              <NuxtLink
                :to="`/roles/${role.id}`"
                class="underline"
              >{{ t('users.objectRoles.permissionsLink') }}</NuxtLink>
            </p>
          </template>
        </div>
        <USwitch
          :model-value="roleIds.includes(role.id)"
          :disabled="disabled"
          :aria-label="t('users.objectRoles.toggle', { role: role.name })"
          @update:model-value="(on: boolean) => toggle(role.id, on)"
        />
      </li>
      <li
        v-if="shown.length === 0 && others.length > 0"
        class="px-3 py-2 text-sm text-muted"
      >
        {{ t('users.objectRoles.noMatch') }}
      </li>
    </ul>
  </div>
</template>
