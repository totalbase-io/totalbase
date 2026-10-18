<script setup lang="ts">
/**
 * The Publish action of an object page (Specification_Admin_UI.md §3.7): the same button and confirmation popover
 * on a DataView's, a Dashboard's and a Workflow's design and settings screens - "Publish as vN?", a note on what it
 * makes live, an optional note on what the version changes (Specification.md §13.3) and the page's own warnings in
 * the slot. Solid while there is something to publish, soft otherwise. With `diagnosis`, what would still stop it from
 * working once published (useDiagnosis.ts) - warnings, never blockers: an administrator may publish anyway.
 */
const props = defineProps<{
  loading?: boolean
  /** Nothing to publish. */
  disabled?: boolean
  /** The version Publish would create. */
  nextVersion: number
  /** What publishing makes live - the pillar's own words. */
  note: string
  /** The object whose diagnosis the dialog lists. */
  diagnosis?: { kind: 'dataview' | 'dashboard', objectId: string }
}>()
/** `open`: the popover opened - a page may check what a publish would affect. */
const emit = defineEmits<{ publish: [note: string | undefined], open: [] }>()
const { t } = useI18n()
const open = ref(false)
const draftNote = ref('')
const { issues, refresh } = useDiagnosis(() => props.diagnosis?.kind ?? 'dataview', () => props.diagnosis?.objectId)
// Publishing is what fixes "not published".
const pending = computed(() => issues.value.filter(i => i.code !== 'NOT_PUBLISHED'))
watch(open, (value) => {
  if (value) {
    draftNote.value = ''
    emit('open')
    if (props.diagnosis) void refresh()
  }
})
function confirm() {
  open.value = false
  emit('publish', draftNote.value.trim() || undefined)
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      :loading="loading"
      :disabled="disabled"
      icon="i-lucide-upload"
      :label="t('common.publish')"
      color="success"
      :variant="disabled ? 'soft' : 'solid'"
    />
    <template #content>
      <div class="flex w-72 flex-col gap-2 p-3">
        <p class="text-sm font-medium">
          {{ t('common.publishAs', { version: nextVersion }) }}
        </p>
        <p class="text-xs text-muted">
          {{ props.note }}
        </p>
        <slot />
        <DiagnosisList
          v-if="diagnosis && pending.length > 0"
          :kind="diagnosis.kind"
          :object-id="diagnosis.objectId"
          :issues="pending"
        />
        <UFormField
          :label="t('shell.versions.noteLabel')"
          :description="t('shell.versions.noteHelp')"
          size="xs"
        >
          <UTextarea
            v-model="draftNote"
            :rows="2"
            :maxlength="128"
            size="sm"
            class="w-full"
            @keydown.enter.exact.prevent="confirm"
          />
        </UFormField>
        <div class="flex justify-end gap-2 pt-1">
          <UButton
            :label="t('common.cancel')"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('common.publish')"
            size="xs"
            color="success"
            :loading="loading"
            @click="confirm"
          />
        </div>
      </div>
    </template>
  </UPopover>
</template>
