<script setup lang="ts">
/**
 * The read-only preview banner every pillar's editor shows while an old
 * version is open (Foundations.md §13.4, §7): nothing in the
 * editor is editable, and the only ways forward are Restore (this content
 * replaces the draft - nothing is published; Publish stays the one way to
 * go live), Save as… (fork it into a new object) or Back to draft.
 *
 * Restore confirms first - a `UPopover`, AGENTS.md §25's small anchored
 * action - but only when the draft has unpublished changes, since those
 * are what it replaces; otherwise it runs straight away. Restoring the
 * live version is how unpublished changes are discarded, so it's only
 * disabled when there are none (it would change nothing).
 */
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()
const { t } = useI18n()
const props = defineProps<{
  version: number
  publishedAt: string
  isLive: boolean
  hasUnpublishedChanges: boolean
  restoring?: boolean
}>()
const emit = defineEmits<{ restore: [], saveAs: [], back: [] }>()

const confirmOpen = ref(false)
const date = computed(() => dates.dateTime(props.publishedAt, { dateStyle: 'medium', timeStyle: 'short' }))

function onRestore() {
  if (props.hasUnpublishedChanges) {
    confirmOpen.value = true
    return
  }
  emit('restore')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 rounded-lg border border-info/30 bg-info/10 px-3 py-2">
    <UIcon
      name="i-lucide-eye"
      class="size-4 shrink-0 text-info"
    />
    <p class="min-w-0 flex-1 text-sm">
      <span class="font-medium text-highlighted">{{ t('shell.versions.viewing', { version }) }}</span>
      <span class="text-muted"> · {{ date }} · {{ t('shell.versions.readOnly') }}</span>
      <UBadge
        v-if="isLive"
        :label="t('common.active')"
        color="success"
        variant="subtle"
        size="sm"
        class="ml-1 align-middle"
      />
    </p>
    <div class="flex items-center gap-2">
      <UPopover v-model:open="confirmOpen">
        <UButton
          icon="i-lucide-rotate-ccw"
          :label="t('shell.versions.restore')"
          size="sm"
          :disabled="isLive && !hasUnpublishedChanges"
          :loading="restoring"
          @click="onRestore"
        />
        <template #content>
          <div class="flex max-w-72 flex-col gap-2 p-3">
            <p class="text-sm font-medium">
              {{ t('shell.versions.restoreConfirm', { version }) }}
            </p>
            <p class="text-xs text-muted">
              {{ t('shell.versions.restoreDescription', { version }) }}
            </p>
            <div class="flex justify-end gap-2 pt-1">
              <UButton
                :label="t('common.cancel')"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="confirmOpen = false"
              />
              <UButton
                :label="t('shell.versions.restore')"
                size="xs"
                color="warning"
                @click="confirmOpen = false; emit('restore')"
              />
            </div>
          </div>
        </template>
      </UPopover>
      <UButton
        icon="i-lucide-copy-plus"
        :label="t('shell.versions.saveAs')"
        size="sm"
        color="neutral"
        variant="outline"
        @click="emit('saveAs')"
      />
      <UButton
        icon="i-lucide-arrow-left"
        :label="t('shell.versions.backToDraft')"
        size="sm"
        color="neutral"
        variant="ghost"
        @click="emit('back')"
      />
    </div>
  </div>
</template>
