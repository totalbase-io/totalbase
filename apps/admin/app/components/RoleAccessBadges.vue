<script setup lang="ts">
/**
 * A role's access flags as badges - one per flag it grants (Admin / App /
 * API), or a muted "No access" when it grants none (its members can't
 * sign in anywhere, though its permissions still apply to anything they
 * reach through another role). `header` sizes them to the editor header's
 * controls (`page-header__tall`, main.css).
 */
import { ROLE_ACCESS_META, grantedAccessFlags, type RoleAccessFlags } from '~/utils/role-access'

const props = withDefaults(defineProps<{
  role: RoleAccessFlags
  size?: 'sm' | 'header'
}>(), {
  size: 'sm'
})

const { t } = useI18n()
const flags = computed(() => grantedAccessFlags(props.role))
const badgeClass = computed(() => props.size === 'header' ? 'page-header__tall px-2.5' : undefined)
</script>

<template>
  <div class="flex items-center gap-1.5">
    <UBadge
      v-for="flag in flags"
      :key="flag"
      :color="ROLE_ACCESS_META[flag].color"
      :icon="ROLE_ACCESS_META[flag].icon"
      :label="t(ROLE_ACCESS_META[flag].labelKey)"
      :size="size === 'sm' ? 'sm' : undefined"
      :class="badgeClass"
      variant="subtle"
    />
    <UBadge
      v-if="flags.length === 0"
      :label="t('users.roleAccess.noAccess')"
      color="neutral"
      variant="outline"
      :size="size === 'sm' ? 'sm' : undefined"
      :class="badgeClass"
    />
  </div>
</template>
