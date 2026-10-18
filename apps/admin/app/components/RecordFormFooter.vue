<script setup lang="ts">
/**
 * A record form's footer while it can be edited (AGENTS.md section 25,
 * record forms): Cancel and Save, pinned under the form in every container
 * - a FORM's page, a grid's record in a drawer, modal, sidebar or its own
 * route. Centered on a desktop; on a phone the two share the width, under
 * the thumb. Save & New is the record's "⋮" (utils/record-menu.ts).
 */
import { shortcutLabel } from '~/composables/useRecordFormShortcuts'

const props = defineProps<{
  saving?: boolean
  /** Save's own label - "Save" by default. */
  saveLabel?: string
}>()
const emit = defineEmits<{ cancel: [], save: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex w-full items-center justify-center gap-2">
    <UButton
      :label="t('common.cancel')"
      color="neutral"
      variant="outline"
      class="justify-center max-md:flex-1"
      :disabled="saving"
      @click="emit('cancel')"
    />
    <UTooltip :text="t('dataviews.record.saveShortcut', { shortcut: shortcutLabel('S') })">
      <UButton
        :label="props.saveLabel ?? t('common.save')"
        icon="i-lucide-save"
        class="justify-center max-md:flex-1"
        :loading="saving"
        @click="emit('save')"
      />
    </UTooltip>
  </div>
</template>
