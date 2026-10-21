<script setup lang="ts">
/**
 * A grid's record form when it's a page (DataViews.md §6.1):
 * the DataView's generated page (CustomPage.vue) in the
 * container its Edit presentation says - drawer, modal or sidebar
 * (EditFormShell.vue) - framed header-body-footer (AGENTS.md section 25):
 * the header holds one "⋮" menu (Clone, Copy, Print, Activity, Delete); the
 * footer, Cancel and Save (Save & New in Save's menu). While an edit is in
 * progress only the footer's Cancel and Save show. Save and Cancel both go
 * back to the view it was opened from - no stepping through rows here,
 * that's a FORM's (DataViewRecordPage.vue). Every one of them acts on the page's record (`dataview.vars.record`);
 * the page itself holds only its fields and whatever its author added.
 *
 * Mounted once, then reused: each opening points the same page's record at
 * another row, or a new one. With the PAGE presentation it's the whole page
 * of its own route (`/app/dataviews/:slug/new`, `/:pk/edit`) - the same
 * form and actions, closing back to where it came from, laid out by the
 * DataView's page options (content width and align, fit to screen).
 */
import { columnTitles } from '~/utils/field-presentation'
import { pageContentClassOf, resolveFitToScreen, type DataView, type DataViewField, type EditPresentation, type EditSide, type FormSize } from '~/types/dataview'
import type { WidgetRuntime } from '~/composables/useWidgetRuntime'
import type { DropdownMenuItem } from '@nuxt/ui'
import { isEditing } from '~/utils/record-engine'
import { recordMenu } from '~/utils/record-menu'
import CustomPage from '~/components/CustomPage.vue'

const props = defineProps<{
  dataview: DataView
  /** The published fields - its page's widgets, and its grid's columns (Copy and Print read their formats). */
  fields: DataViewField[]
  mode: 'create' | 'edit' | 'view'
  /** The row to open (edit, view). */
  row: Record<string, unknown> | null
  /** A new record's starting values - a Detail's link to its master, a Calendar's day. */
  initialValues?: Record<string, unknown> | null
  primaryKey: string
  presentation: EditPresentation
  size?: FormSize
  side?: EditSide
  /** The DataView's `record*` features (TABLE_FEATURES, group form). */
  features: Record<string, boolean>
  /** A DataView preview: the page reads the draft's table as an administrator. */
  preview?: boolean
  note?: string
  /** Clone - the viewer's CREATE; unset, allowed. */
  canCreate?: boolean
  /** Delete - the viewer's DELETE; unset, allowed. */
  canDelete?: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  saved: [row: Record<string, unknown>]
  deleted: []
  /** One of its own actions ran - what lists it reads again. */
  changed: []
}>()

const toast = useToast()
const router = useRouter()
const { t } = useI18n()
// A record's history is the audit log - an administrator's to read: Activity is offered only to them.
const { admin: viewer } = useSession()
const readsActivity = computed(() => viewer.value?.access === 'ADMIN')
/** Leaves the record: the container closes, or the page goes back - to its DataView when it was opened by its address (a new tab: nothing of the App to go back to). */
function close() {
  if (props.presentation === 'PAGE') {
    if (window.history.state?.back) router.back()
    else void router.replace(`/app/dataviews/${props.dataview.slug}`)
  } else open.value = false
}

// --- PAGE: the record page's options (DataViews.md §6.7) ---------------
const pageConfig = computed(() => props.dataview.viewConfig ?? {})
const contentClass = computed(() => pageContentClassOf(props.dataview, 'record'))
const isCompact = useCompactUi()
/** Fit to screen - ignored on a phone or a tablet. */
const fitToScreen = computed(() => resolveFitToScreen(pageConfig.value) && !isCompact.value)

const runtime = shallowRef<WidgetRuntime | null>(null)
const record = computed(() => runtime.value?.record ?? null)
const mode = computed(() => record.value?.mode ?? props.mode)
const saving = computed(() => record.value?.status === 'pending')
const pkOf = (row: Record<string, unknown> | null) => (row ? row[props.primaryKey] : null)

/** Points the page's record at this opening's row - or a new one. */
async function applyOpening() {
  const current = record.value
  if (!current) return
  if (props.mode === 'create') current.new({ ...props.initialValues })
  // The grid's row shows at once; the read that follows keeps what's typed meanwhile.
  else await current.open(pkOf(props.row), props.mode === 'view', props.row ?? undefined)
}
function onReady(value: WidgetRuntime) {
  runtime.value = value
  // An existing row the page started on already (`initialParams`): reading it again would overwrite what's typed meanwhile.
  // A new one still gets its starting values (a Detail's link, a Calendar's day) - nothing is read for it.
  const opened = props.mode !== 'create' && pkOf(props.row) === initialParams.pk
  if (!opened) void applyOpening()
}
watch(open, (value) => {
  if (value) void applyOpening()
})
/** The first opening, before the page exists: where it starts. */
const initialParams = { pk: props.mode === 'create' ? undefined : pkOf(props.row) }

// --- Copy and Print: the page's fields, in its order, with the grid's formats ---------

const outputs = useRecordOutputs({ dataview: toRef(props, 'dataview'), fields: toRef(props, 'fields') })

// --- Save, cancel, delete, history --------------------------------------------------

/** Asked before unsaved edits are dropped: closing the container, leaving the page (useDiscardGuard). */
const { confirmDiscard } = useDiscardGuard(() => open.value && Boolean(record.value?.dirty))
/** The container's own close (X, Esc, outside) - asks first when there are unsaved edits. */
const shellOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (value) open.value = true
    else void confirmDiscard().then(ok => ok && (open.value = false))
  }
})

async function save(): Promise<boolean> {
  const current = record.value
  if (!current || !await current.save()) return false
  toast.add({ title: t('dataviews.record.saved'), color: 'success' })
  emit('saved', { ...current.data })
  return true
}
async function onSave() {
  if (await save()) close()
}
async function onSaveAndNew() {
  if (await save()) record.value?.new({ ...props.initialValues })
}
/** Cancel discards the edits and goes back to the view it came from - as Save does. */
function onCancel() {
  record.value?.cancel()
  close()
}
async function onDelete() {
  if (await record.value?.delete()) {
    emit('deleted')
    close()
  }
}
const historyOpen = ref(false)
/** The DataView's name - its author's, not the table's. */
const title = computed(() => t(mode.value === 'create' ? 'dataviews.record.titleNew' : mode.value === 'view' ? 'dataviews.record.titleView' : 'dataviews.record.titleEdit', { name: props.dataview.name }))

// --- The frame: header actions at rest, Cancel and Save while editing (AGENTS.md section 25) ---

const canWrite = computed(() => props.mode !== 'view')
/** An edit in progress: only the footer's Cancel and Save show. */
const editingNow = computed(() => (record.value ? isEditing(record.value) : props.mode === 'create'))
/** The DataView's own actions on this record (DataViews.md §3.7) - done, the list behind reloads too. */
const customActions = useRecordCustomActions(toRef(props, 'dataview'), record, () => emit('changed'))
const headerMenu = computed<DropdownMenuItem[][]>(() => {
  const current = record.value
  // While editing, the record's actions step aside: Save & New is all its "⋮" holds.
  if (editingNow.value || mode.value === 'create') {
    return canWrite.value && props.features.recordSaveAndNew ? recordMenu({ saveAndNew: () => void onSaveAndNew() }, t) : []
  }
  if (!current) return []
  return recordMenu({
    custom: customActions.items.value,
    clone: canWrite.value && props.canCreate !== false && props.features.recordClone ? () => current.clone() : undefined,
    copy: props.features.recordCopy ? () => void outputs.copy(current.data, current.pk) : undefined,
    print: props.features.recordPrint ? () => void outputs.print(current.data, current.pk) : undefined,
    activity: readsActivity.value && props.features.recordHistory ? () => (historyOpen.value = true) : undefined,
    delete: canWrite.value && props.canDelete !== false ? () => void onDelete() : undefined
  }, t)
})
/** The footer: while the record can be edited. */
const showFooter = computed(() => canWrite.value && mode.value !== 'view')

// Ctrl/⌘+S saves, +Shift saves and starts a new one, +D clones.
const editing = computed(() => open.value && mode.value !== 'view')
useRecordFormShortcuts(editing, { onSave: () => void onSave(), onSaveAndNew: () => void onSaveAndNew(), onClone: () => record.value?.clone() }, {
  saveAndNew: computed(() => props.features.recordSaveAndNew),
  clone: computed(() => props.features.recordClone && mode.value !== 'create')
})
</script>

<template>
  <!-- PAGE: its own route - PageShell's header, body and footer. -->
  <PageShell
    v-if="presentation === 'PAGE'"
    :scroll="!fitToScreen"
  >
    <template #header>
      <PageHeader
        :title="title"
        :description="dataview.name"
        icon="i-lucide-arrow-left"
        icon-back
        :menu="headerMenu"
      />
    </template>
    <div :class="[contentClass, fitToScreen ? 'h-full' : undefined]">
      <CustomPage
        :dataview="dataview"
        :fields="fields"
        :params="initialParams"
        :record-view="mode === 'view'"
        :preview="preview"
        @ready="onReady"
        @close="close"
      />
    </div>
    <template
      v-if="showFooter"
      #footer
    >
      <RecordFormFooter
        :saving="saving"
        @cancel="onCancel"
        @save="onSave"
      />
    </template>
  </PageShell>
  <EditFormShell
    v-else
    v-model:open="shellOpen"
    :presentation="presentation"
    :title="title"
    :description="[t(mode === 'create' ? 'dataviews.record.descriptionCreate' : mode === 'view' ? 'dataviews.record.descriptionView' : 'dataviews.record.descriptionEdit'), note].filter(Boolean).join(' ')"
    :size="size"
    :side="side"
  >
    <template
      v-if="headerMenu.length"
      #actions
    >
      <RecordHeaderActions :menu="headerMenu" />
    </template>

    <!-- Scrolls - and clips at its edges: a 4px margin of its own (-m-1 p-1) keeps a card's ring, at the top
    or the side of the form, whole (an UCard's border is a ring outside its box). -->
    <div class="-m-1 flex min-h-0 flex-1 flex-col overflow-y-auto p-1">
      <CustomPage
        :dataview="dataview"
        :fields="fields"
        :params="initialParams"
        :record-view="mode === 'view'"
        :preview="preview"
        @ready="onReady"
        @close="close"
      />
    </div>

    <template
      v-if="showFooter"
      #footer
    >
      <RecordFormFooter
        :saving="saving"
        @cancel="onCancel"
        @save="onSave"
      />
    </template>
  </EditFormShell>

  <RecordHistoryPanel
    v-if="record && record.pk !== null && dataview.sourceResource"
    v-model:open="historyOpen"
    :resource-id="dataview.sourceResource"
    :primary-key="primaryKey"
    :pk-value="String(record.pk)"
    :resource-label="dataview.name"
    :field-order="outputs.printedFields.value.map(f => f.columnName!)"
    :field-labels="columnTitles(fields)"
  />
</template>
