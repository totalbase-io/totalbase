<script setup lang="ts">
/**
 * The rail's foot (layouts/default.vue): the environment's badge and the account menu - on a desktop's rail and
 * on the rail inside a phone's navigation.
 */
import type { DropdownMenuItem } from '@nuxt/ui'

defineProps<{
  environment?: string
  environmentColor: 'error' | 'warning' | 'neutral'
  items: DropdownMenuItem[][]
}>()

const session = useSession()
const { t } = useI18n()
</script>

<template>
  <div class="mt-auto flex flex-col items-center gap-2 pb-3">
    <UTooltip
      v-if="environment"
      :text="t('shell.environment', { environment })"
      :content="{ side: 'right' }"
    >
      <UBadge
        :color="environmentColor"
        variant="subtle"
        size="sm"
        class="justify-center w-8 h-6"
      >
        {{ environment[0]?.toUpperCase() }}
      </UBadge>
    </UTooltip>
    <UDropdownMenu
      :items="items"
      :content="{ side: 'right', align: 'end' }"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="lg"
        square
        :aria-label="t('shell.account')"
        :icon="session.admin.value?.avatarUrl ? undefined : 'i-lucide-user'"
      >
        <UAvatar
          v-if="session.admin.value?.avatarUrl"
          :src="session.admin.value.avatarUrl"
          :alt="session.admin.value.name || session.admin.value.email || undefined"
          size="sm"
        />
      </UButton>
    </UDropdownMenu>
  </div>
</template>
