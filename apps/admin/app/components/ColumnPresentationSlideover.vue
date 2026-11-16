<script setup lang="ts">
/**
 * Edits one column's presentation (DataViews.md §15)
 * from the Columns tab - for any column of a table or a view,
 * created by TotalBase or not. A sidebar, so the columns stay in sight
 * while going from one to the next. Saving replaces it whole: an option
 * left empty is unset, and the views inheriting it fall back to their
 * default. A table's column also has a Database tab - its structure, as ALTER
 * statements shown while edited; Save runs them first and the presentation
 * with them, in one transaction: both apply, or neither
 * (Administration.md §3.11).
 */
import type { ColumnPresentation, ValueKind } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { EditOperationBody, RelationDetail } from '~/types/schema'

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
  /** A table's column: its structure, the Database tab - none for a view's. */
  structure?: { column: CatalogColumn, detail: RelationDetail, readOnly: boolean }
}>()
const open = defineModel<boolean>('open', { required: true })
/** `structural`: its ALTERs ran - the table changed, not only how the column shows. */
const emit = defineEmits<{ saved: [structural: boolean] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const draft = ref<ColumnPresentation>({})
watch([open, () => props.columnName], ([isOpen]) => {
  if (isOpen) draft.value = structuredClone(toRaw(props.presentation))
}, { immediate: true })

/** Properties (what it is and says), Styles (how it always looks), Conditions (how it looks when something holds). */
const tab = ref<'properties' | 'styles' | 'conditions' | 'database'>('properties')
watch(open, (isOpen) => {
  if (isOpen) tab.value = 'properties'
})
const structureChange = ref<{ operations: EditOperationBody[], columnName: string, valid: boolean }>({ operations: [], columnName: props.columnName, valid: true })
/** Icons, their title on hover (and to assistive tech) - four titles don't fit the panel's width. */
const TABS = computed(() => [
  { label: t('database.columnPresentationSlideover.tabs.properties'), icon: 'i-lucide-tag', value: 'properties' },
  { label: t('database.columnPresentationSlideover.tabs.styles'), icon: 'i-lucide-palette', value: 'styles' },
  { label: t('database.columnPresentationSlideover.tabs.conditions'), icon: 'i-lucide-list-filter', value: 'conditions', badge: draft.value.conditions?.length ? String(draft.value.conditions.length) : undefined },
  ...(props.structure ? [{ label: t('database.columnPresentationSlideover.tabs.database'), icon: 'i-lucide-database', value: 'database', badge: structureChange.value.operations.length ? String(structureChange.value.operations.length) : undefined }] : [])
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
const structural = computed(() => structureChange.value.operations.length > 0)
async function save() {
  saving.value = true
  try {
    if (structural.value && props.structure) {
      // The ALTERs first, the presentation after them under the column's new name - one transaction.
      await api.post(`/schema/${props.resource.schema}/tables/${props.resource.name}/edit`, {
        data: { operations: structureChange.value.operations, columnPresentation: { column: structureChange.value.columnName, presentation: draft.value } }
      })
    } else {
      await api.put(`/resources/${props.resourceId}/columns/${encodeURIComponent(props.columnName)}/presentation`, { data: { presentation: draft.value } })
    }
    toast.add({ title: t('database.columnPresentationSlideover.saved'), color: 'success' })
    open.value = false
    emit('saved', structural.value)
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
        >
          <template #leading="{ item }">
            <UTooltip :text="item.label">
              <UIcon
                :name="item.icon!"
                class="size-4"
              />
            </UTooltip>
          </template>
          <template #default="{ item }">
            <span class="sr-only">{{ item.label }}</span>
          </template>
        </UTabs>
        <p
          v-if="inheritedKeys.length"
          class="text-xs text-muted"
        >
          {{ t('database.columnPresentationSlideover.inherits', { keys: inheritedKeys.join(', ') }) }}
        </p>
        <!-- A table's column: its structure - kept mounted, so a draft survives going to another tab. -->
        <template v-if="structure">
          <NotOwnedNote
            v-if="structure.readOnly && tab === 'database'"
            kind="table"
            :owner="structure.detail.owner"
          />
          <ColumnStructureFields
            v-show="tab === 'database'"
            :schema="resource.schema"
            :table="resource.name"
            :column="structure.column"
            :detail="structure.detail"
            :read-only="structure.readOnly"
            @change="(change) => structureChange = change"
          />
        </template>
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
        <template v-if="tab === 'styles' || tab === 'conditions'">
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
          :disabled="!structureChange.valid"
          @click="save"
        />
      </div>
    </template>
  </USlideover>
</template>
