<script setup lang="ts">
/**
 * Edits one column's presentation (DataViews.md §15)
 * from the Columns tab - for any column of a table or a view,
 * created by TotalBase or not. A sidebar, so the columns stay in sight
 * while going from one to the next. Saving replaces it whole: an option
 * left empty is unset, and the views inheriting it fall back to their
 * default.
 */
import type { ColumnPresentation, ValueKind } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

const props = defineProps<{
  resourceId: string
  columnName: string
  dataType: string
  kind: ValueKind
  checkValues: string[] | null
  presentation: ColumnPresentation
  /** A view's column: its table column's presentation, under this one key by key (§15.1). */
  inherited?: ColumnPresentation
  /** What Automatic edits it with - the rule's input, its props and why (§15.2). */
  automatic?: { input: string, widget: string, reason: string }
  /** The catalog entries that edit it - its Control's choices. */
  inputs?: string[]
  /** Its table or view - the preview's rows. */
  resource: { schema: string, name: string, type: string }
  /** The table's columns - a condition's filter builder. */
  columns?: CatalogColumn[]
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const draft = ref<ColumnPresentation>({})
watch([open, () => props.columnName], ([isOpen]) => {
  if (isOpen) draft.value = structuredClone(toRaw(props.presentation))
}, { immediate: true })

/** Properties (what it is and says), Styles (how it always looks), Conditions (how it looks when something holds). */
const tab = ref<'properties' | 'styles' | 'conditions'>('properties')
const TABS = computed(() => [
  { label: t('database.columnPresentationSlideover.tabs.properties'), value: 'properties' },
  { label: t('database.columnPresentationSlideover.tabs.styles'), value: 'styles' },
  { label: t('database.columnPresentationSlideover.tabs.conditions'), value: 'conditions', badge: draft.value.conditions?.length ? String(draft.value.conditions.length) : undefined }
])
const conditions = computed({
  get: () => draft.value.conditions ?? [],
  set: (next) => { draft.value = { ...draft.value, conditions: next.length ? next : undefined } }
})

/** The options it inherits that it doesn't set itself - they still show. */
const inheritedKeys = computed(() => Object.keys(props.inherited ?? {}).filter(key => (draft.value as Record<string, unknown>)[key] === undefined))
/** How it shows: what it inherits, under its own draft. */
const effective = computed<ColumnPresentation>(() => ({ ...props.inherited, ...draft.value }))

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await api.put(`/resources/${props.resourceId}/columns/${encodeURIComponent(props.columnName)}/presentation`, { data: { presentation: draft.value } })
    toast.add({ title: t('database.columnPresentationSlideover.saved'), color: 'success' })
    open.value = false
    emit('saved')
  } catch (err) {
    notifyError(err, t('database.columnPresentationSlideover.saveError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="columnName"
    :description="t('database.columnPresentationSlideover.description', { dataType })"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- What a change here changes: every DataView that shows it. -->
        <ColumnUsageNote
          :resource-id="resourceId"
          :column-name="columnName"
        />
        <UTabs
          v-model="tab"
          :items="TABS"
          :content="false"
          class="w-full"
        />
        <p
          v-if="inheritedKeys.length"
          class="text-xs text-muted"
        >
          {{ t('database.columnPresentationSlideover.inherits', { keys: inheritedKeys.join(', ') }) }}
        </p>
        <ColumnPresentationFields
          v-show="tab === 'properties'"
          v-model="draft"
          :column-name="columnName"
          :kind="kind"
          :check-values="checkValues"
          :inherited="inherited"
          :automatic="automatic"
          :inputs="inputs"
          part="properties"
        />
        <!-- Styles and Conditions: a few real rows above, as a table shows them. -->
        <template v-if="tab !== 'properties'">
          <ColumnPresentationPreview
            :resource="resource"
            :column-name="columnName"
            :presentation="effective"
          />
          <TableCellStyleFields
            v-if="tab === 'styles'"
            :model-value="draft"
            @update:model-value="(style) => draft = style as ColumnPresentation"
          />
          <ColumnConditionsEditor
            v-else
            v-model="conditions"
            :columns="columns"
            :column-name="columnName"
          />
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('common.save')"
          :loading="saving"
          @click="save"
        />
      </div>
    </template>
  </USlideover>
</template>
