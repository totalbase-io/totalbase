<script setup lang="ts">
/**
 * The standalone App menu's foot (Admin_UI.md §3.1.1): the signed-in user -
 * avatar, name, email - opening the account menu (My account, theme, log
 * out), and the environment's badge: what the rail's cluster is in the
 * shared shell (RailAccountCluster.vue).
 */
import type { DropdownMenuItem } from '@nuxt/ui'

defineProps<{
  environment?: string
  environmentColor: 'error' | 'warning' | 'neutral'
  items: DropdownMenuItem[][]
}>()

const session = useSession()
const { t } = useI18n()
const name = computed(() => session.admin.value?.name || '')
const email = computed(() => session.admin.value?.email || '')
</script>

<template>
  <div class="flex w-full min-w-0 items-center gap-2">
    <UDropdownMenu
      :items="items"
      :content="{ side: 'top', align: 'start' }"
      class="min-w-0 flex-1"
    >
      <UButton
        color="neutral"
        variant="ghost"
        class="w-full justify-start"
        :aria-label="t('shell.account')"
      >
        <UAvatar
          :src="session.admin.value?.avatarUrl ?? undefined"
          :alt="name || email || undefined"
          icon="i-lucide-user"
          size="sm"
        />
        <span class="flex min-w-0 flex-col items-start text-left">
          <span class="w-full truncate text-sm font-medium text-highlighted">{{ name || email }}</span>
          <span
            v-if="name && email"
            class="w-full truncate text-xs text-muted"
          >{{ email }}</span>
        </span>
      </UButton>
    </UDropdownMenu>
    <UTooltip
      v-if="environment"
      :text="t('shell.environment', { environment })"
    >
      <UBadge
        :color="environmentColor"
        variant="subtle"
        size="sm"
        class="w-8 justify-center"
      >
        {{ environment[0]?.toUpperCase() }}
      </UBadge>
    </UTooltip>
  </div>
</template>
