<script setup lang="ts">
/**
 * A record's actions in its form's header - one "⋮" menu, the same on a
 * desktop and a phone, in every container (a modal's, a sidebar's, a
 * drawer's header): Clone, Copy, Print, History, Delete. The default slot
 * holds a primary action beside it. Hidden by the caller while an edit is
 * in progress - then the footer's Cancel and Save are all there is.
 */
import type { DropdownMenuItem } from '@nuxt/ui'

defineProps<{
  menu: DropdownMenuItem[][]
}>()
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center gap-1">
    <slot />
    <UDropdownMenu
      v-if="menu.length"
      :items="menu"
      :content="{ align: 'end' }"
    >
      <UButton
        icon="i-lucide-ellipsis-vertical"
        :aria-label="t('dataviews.record.actions')"
        color="neutral"
        variant="ghost"
        square
      />
    </UDropdownMenu>
  </div>
</template>
