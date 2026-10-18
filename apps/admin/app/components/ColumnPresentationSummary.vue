<script setup lang="ts">
/**
 * "From the column" (Specification_DataViews.md §15): how a column reads wherever it shows - its label, format, how
 * each value shows, its look and its conditions - read only where it is used (a DataView's column, a form field), with
 * its preview, where else it shows, and "Edit in the table": the one place it is set.
 */
import type { ColumnPresentation } from '@totalbase/tb-catalog'
import { humanizeColumnName } from '~/utils/humanize-column-name'

const props = defineProps<{
  /** The resource the column is - a related column's, its target table. */
  resourceId: string
  columnName: string
  /** Its presentation as it resolves - its own and, for a view's column, its table's. */
  presentation: ColumnPresentation
  /** A foreign key: what it shows of the row it points at - its table's row presentation (§15.5). */
  shows?: string
}>()
const emit = defineEmits<{ saved: [] }>()

const { t } = useI18n()
const { resources } = useResourcesList()
const resource = computed(() => resources.value.find(r => r.id === props.resourceId) ?? null)
const editing = ref(false)

/** What it sets, in the panel's order - each as one line of text. */
const lines = computed(() => {
  const p = props.presentation
  const out: { label: string, value: string }[] = [
    { label: t('common.label'), value: p.label ?? t('database.columnPresentationSummary.labelDefault', { name: humanizeColumnName(props.columnName) }) }
  ]
  const add = (label: string, value: string | undefined) => {
    if (value) out.push({ label, value })
  }
  add(t('database.columnPresentationFields.shortLabel'), p.shortLabel)
  add(t('common.description'), p.description)
  add(t('database.columnPresentationFields.help'), p.help)
  add(t('database.columnPresentationSummary.format'), p.displayFormat)
  add(t('database.columnPresentationFields.trueAs'), p.booleanLabels?.true)
  add(t('database.columnPresentationFields.falseAs'), p.booleanLabels?.false)
  add(t('database.columnPresentationFields.link'), p.linkType)
  add(t('database.columnPresentationFields.emptyText'), p.emptyText)
  add(t('database.columnPresentationSummary.shows'), props.shows)
  return out
})
const options = computed(() => Object.entries(props.presentation.options ?? {}))
const conditions = computed(() => props.presentation.conditions ?? [])
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-start justify-between gap-2">
      <p class="text-xs text-muted">
        {{ t('database.columnPresentationSummary.intro') }}
      </p>
      <UButton
        :label="t('database.columnPresentationSummary.edit')"
        icon="i-lucide-pencil"
        color="neutral"
        variant="outline"
        size="xs"
        class="shrink-0"
        @click="editing = true"
      />
    </div>
    <ColumnUsageNote
      :resource-id="resourceId"
      :column-name="columnName"
    />
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <template
        v-for="line in lines"
        :key="line.label"
      >
        <dt class="text-muted">
          {{ line.label }}
        </dt>
        <dd class="min-w-0 break-words">
          {{ line.value }}
        </dd>
      </template>
    </dl>
    <div
      v-if="options.length"
      class="flex flex-wrap gap-1"
    >
      <UBadge
        v-for="[value, option] in options"
        :key="value"
        :label="option.label ?? value"
        :icon="option.icon"
        :color="option.color ?? 'neutral'"
        variant="subtle"
      />
    </div>
    <div
      v-if="conditions.length"
      class="flex flex-col gap-1"
    >
      <p class="text-sm font-medium">
        {{ t('database.columnPresentationSlideover.tabs.conditions') }}
      </p>
      <p
        v-for="condition in conditions"
        :key="condition.name"
        class="text-sm"
        :class="condition.enabled === false ? 'text-dimmed line-through' : ''"
      >
        {{ condition.name }}
        <span class="text-xs text-muted">· {{ condition.applyTo === 'row' ? t('database.columnPresentationSummary.row') : t('database.columnPresentationSummary.cell') }}</span>
      </p>
    </div>
    <ColumnPresentationPreview
      v-if="resource"
      :resource="resource"
      :column-name="columnName"
      :presentation="presentation"
    />
    <ColumnPresentationEditor
      v-if="editing"
      v-model:open="editing"
      :resource-id="resourceId"
      :column-name="columnName"
      @saved="emit('saved')"
    />
  </div>
</template>
