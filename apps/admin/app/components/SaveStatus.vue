<script setup lang="ts">
/**
 * The editor header's autosave indicator (useAutosave.ts), beside the
 * title (PageHeader's `#status`) - replaces the
 * old Save buttons in the Dashboards, Workflows and DataViews editors.
 * Quiet by design: muted text, only an error asks for attention (and
 * offers a retry). "Saved" says so for SAVED_FOR ms, then goes - saving
 * and an error stay as long as they last. Icon only on a phone, where the
 * header is tight.
 */
import type { AutosaveStatus } from '~/composables/useAutosave'

const props = withDefaults(defineProps<{
  status: AutosaveStatus
  /** Hide Retry for a caller whose failed writes can't simply be re-sent as a whole (the DataView designer - each failed write already toasts its own error). */
  retryable?: boolean
}>(), { retryable: true })
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()

const SAVED_FOR = 2000
const savedShown = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.status, (status) => {
  if (savedTimer !== undefined) clearTimeout(savedTimer)
  savedShown.value = status === 'saved'
  if (status === 'saved') savedTimer = setTimeout(() => (savedShown.value = false), SAVED_FOR)
}, { immediate: true })
onBeforeUnmount(() => {
  if (savedTimer !== undefined) clearTimeout(savedTimer)
})
</script>

<template>
  <div
    v-if="status === 'saving' || status === 'error' || savedShown"
    class="flex items-center gap-1 text-xs"
    :class="status === 'error' ? 'text-error' : 'text-muted'"
    aria-live="polite"
  >
    <template v-if="status === 'saving'">
      <UIcon
        name="i-lucide-loader-circle"
        class="size-3.5 animate-spin"
      />
      <span class="max-md:sr-only">{{ t('shell.saveStatus.saving') }}</span>
    </template>
    <template v-else-if="status === 'saved'">
      <UIcon
        name="i-lucide-check"
        class="size-3.5"
      />
      <span class="max-md:sr-only">{{ t('shell.saveStatus.saved') }}</span>
    </template>
    <template v-else>
      <UIcon
        name="i-lucide-alert-circle"
        class="size-3.5"
      />
      <span class="max-md:sr-only">{{ t('shell.saveStatus.error') }}</span>
      <UButton
        v-if="retryable"
        :label="t('shell.saveStatus.retry')"
        size="xs"
        color="error"
        variant="ghost"
        @click="emit('retry')"
      />
    </template>
  </div>
</template>
