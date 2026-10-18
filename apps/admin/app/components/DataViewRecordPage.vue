<script setup lang="ts">
/**
 * A FORM or MASTER_DETAIL whose record form is a page (Specification_DataViews.md §6.4):
 * the page frame around CustomPage.vue - title, New, Edit,
 * Previous/Next, Delete - driving the page's record (`dataview.vars.record`,
 * record-engine.ts). What the form holds and its buttons are the page's own
 * content; this only moves between records.
 *
 * - FORM (`form_view_mode`): READ opens a row read-only until Edit; UPDATE
 *   opens it editable; CREATE always starts a new one. The row is `?pk=`,
 *   else the first by key; Previous/Next step through the keys in order.
 * - MASTER_DETAIL: a record is created at once, with the table's defaults,
 *   so its Detail has one to add rows to - unless "On open" is Wait, which
 *   shows a start screen whose New starts it.
 *
 * Framed header-body-footer (AGENTS.md section 25): the header holds Edit,
 * New, Search, Previous/Next and a menu (Copy, Print, Activity, Delete); the
 * footer - while the record can be edited - Cancel and Save (Save & New in
 * Save's menu). While an edit is in progress only the footer shows its
 * actions. Edits in progress are never dropped without asking
 * (useDiscardGuard): New, Previous/Next, a search pick, leaving the page.
 *
 * `?pk=` follows the open record, so it can be linked and reloaded. Config
 * arrives as props (AGENTS.md section 21A); only the page's own URL query
 * is this host's to read and write.
 */
import { columnTitles } from '~/utils/field-presentation'
import type { DataView, DataViewField } from '~/types/dataview'
import { dataviewIcon, pageContentClassOf, resolveFeatures, resolveFitToScreen, resolveFormViewMode, resolveMasterDetailOpenWith, resolveNewRecordLabel } from '~/types/dataview'
import type { WidgetRuntime } from '~/composables/useWidgetRuntime'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { HeaderAction } from '~/utils/page-header'
import { fieldColumn, fieldInput } from '~/utils/widget-form'
import { isEditing } from '~/utils/record-engine'
import { recordMenu } from '~/utils/record-menu'
import CustomPage from '~/components/CustomPage.vue'

const props = defineProps<{
  dataview: DataView
  fields: DataViewField[]
  /** A version preview: nothing is written - a blank form. */
  preview?: boolean
}>()

const route = useRoute()
const toast = useToast()
const router = useRouter()
const dataApi = useDataApi()
const { t } = useI18n()
// A record's history is the audit log - an administrator's to read: Activity is offered only to them.
const { admin: viewer } = useSession()
const readsActivity = computed(() => viewer.value?.access === 'ADMIN')

const config = computed(() => props.dataview.viewConfig ?? {})
const isMasterDetail = computed(() => props.dataview.viewType === 'MASTER_DETAIL')
const formMode = computed(() => resolveFormViewMode(config.value))
/** SINGLE: the table's one row (a company's settings) - opened editable, created on the first save when there is none; no New, browsing or Delete. */
const isSingle = computed(() => formMode.value === 'SINGLE')
const waitsForNew = computed(() => isMasterDetail.value && resolveMasterDetailOpenWith(config.value) === 'WAIT')
const newLabel = computed(() => (isMasterDetail.value ? resolveNewRecordLabel(config.value, props.dataview.name, name => t('dataviews.meta.newRecordLabel', { name })) : t('common.new')))
const contentClass = computed(() => pageContentClassOf(props.dataview, 'record'))
const isCompact = useCompactUi()
/** Fit to screen - ignored on a phone or a tablet, where the page scrolls as usual. */
const fitToScreen = computed(() => resolveFitToScreen(config.value) && !isCompact.value)
const table = computed(() => ({
  schema: props.dataview.sourceResourceSchema ?? '',
  name: props.dataview.sourceResourceName ?? '',
  kind: props.dataview.sourceResourceType === 'VIEW' ? 'view' as const : 'table' as const
}))
/** The record's key column - known once the page's record has its catalog. */
const primaryKey = computed(() => record.value?.primaryKey ?? undefined)

// --- The page, and its record ----------------------------------------------------

const runtime = shallowRef<WidgetRuntime | null>(null)
const record = computed(() => runtime.value?.record ?? null)
/** Waiting for New (MASTER_DETAIL's Wait) - the page isn't mounted yet. */
const started = ref(!waitsForNew.value || Boolean(route.query.pk))
/** The row the page opens on: `?pk=`, else (a FORM reading or updating) the first one by key. */
const initialPk = route.query.pk as string | undefined
const pageParams = { ...route.query }

/**
 * MASTER_DETAIL starts a record at once - its defaults, saved - so its
 * Detail has one. Only when it needs nothing from the viewer: with a
 * required column PostgreSQL has no default for (an order's customer), it
 * opens as a new record to fill in - never refused before anything was typed.
 */
async function startRecord() {
  const current = record.value
  if (!current) return
  current.new()
  const needsInput = Object.values(current.columns).some(column => column.required && column.creatable)
  if (isMasterDetail.value && !props.preview && !needsInput) await current.save()
}
async function onReady(value: WidgetRuntime) {
  runtime.value = value
  await loadPkOrder()
  if (initialPk || props.preview) return
  if (isMasterDetail.value) await startRecord()
  else if (isSingle.value) {
    if (pkOrder.value[0] !== undefined) await value.record?.open(pkOrder.value[0], false)
    else value.record?.new()
  } else if (formMode.value !== 'CREATE' && pkOrder.value[0] !== undefined) await value.record?.open(pkOrder.value[0], formMode.value === 'READ')
}

// `?pk=` follows the open record - never a new history entry.
watch(() => record.value?.pk, (pk) => {
  if (props.preview) return
  const value = pk === null || pk === undefined ? undefined : String(pk)
  if ((route.query.pk as string | undefined) === value) return
  const query = { ...route.query }
  if (value) query.pk = value
  else delete query.pk
  void router.replace({ query })
})

// --- Moving between records ----------------------------------------------------------

const PK_ORDER_LIMIT = 1000
const pkOrder = ref<string[]>([])
async function loadPkOrder() {
  if (isMasterDetail.value || formMode.value === 'CREATE' || !primaryKey.value || props.preview) return
  try {
    const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(table.value.schema, table.value.name, table.value.kind), { fields: primaryKey.value, order_by: primaryKey.value, limit: PK_ORDER_LIMIT })
    pkOrder.value = data.map(row => String(row[primaryKey.value!]))
  } catch {
    pkOrder.value = []
  }
}
watch(() => record.value?.pk, (pk, previous) => {
  // A row created or deleted changes the order.
  if ((pk === null) !== (previous === null)) void loadPkOrder()
})
const position = computed(() => (record.value?.pk === null || record.value?.pk === undefined ? -1 : pkOrder.value.indexOf(String(record.value.pk))))
// --- Moving between records, never dropping unsaved edits without asking -------------

const { confirmDiscard } = useDiscardGuard(() => Boolean(record.value?.dirty))
/** The record that was open before New - Cancel returns to it. */
const previousPk = ref<unknown>(null)
async function openRecord(pk: unknown) {
  if (!await confirmDiscard()) return
  await record.value?.open(pk, formMode.value === 'READ')
}
function step(by: -1 | 1) {
  const pk = pkOrder.value[position.value + by]
  if (pk !== undefined) void openRecord(pk)
}

async function onNew() {
  if (!started.value) {
    started.value = true
    return
  }
  if (!await confirmDiscard()) return
  previousPk.value = record.value?.pk ?? null
  void startRecord()
}
// --- The frame: header at rest, footer's Cancel and Save while editing (AGENTS.md section 25) ---

/** An edit in progress: the header's actions step aside, the footer's Cancel and Save are all there is. */
const editingNow = computed(() => (record.value ? isEditing(record.value) : false))
/**
 * The footer: while the record can be edited - unless the DataView turns its
 * Save and Cancel off (`recordSaveCancel`), because the page saves through its
 * own buttons; Ctrl/⌘+S follows it.
 */
const showFooter = computed(() => started.value && Boolean(record.value) && record.value!.mode !== 'view' && features.value.recordSaveCancel !== false)
const saving = computed(() => record.value?.status === 'pending')

async function onSave() {
  if (!await record.value?.save()) return
  toast.add({ title: t('dataviews.record.saved'), color: 'success' })
  // A CREATE form is always a blank new record: a save starts the next (Specification_DataViews.md §6.5, B47).
  if (formMode.value === 'CREATE' && !isMasterDetail.value) {
    previousPk.value = null
    void startRecord()
  }
}
async function onSaveAndNew() {
  if (!await record.value?.save()) return
  toast.add({ title: t('dataviews.record.saved'), color: 'success' })
  previousPk.value = null
  void startRecord()
}
/**
 * Cancel discards the edits: a record opened read-only returns to reading; a
 * new one goes back to the record that was open (or starts over when there
 * was none); an editable one keeps its saved values.
 */
function onCancel() {
  const current = record.value
  if (!current) return
  if (current.mode === 'create' && !isMasterDetail.value && previousPk.value !== null && previousPk.value !== undefined) {
    void current.open(previousPk.value, formMode.value === 'READ')
  } else if (current.mode === 'create' && !isMasterDetail.value) {
    current.new()
  } else {
    current.cancel()
  }
}

const headerActions = computed<HeaderAction[]>(() => {
  if (isMasterDetail.value || formMode.value === 'CREATE' || isSingle.value || !started.value || editingNow.value) return []
  return [
    ...(canSearch.value ? [{ label: t('common.search'), icon: 'i-lucide-search', iconOnly: true, onSelect: () => (searchOpen.value = true) }] : []),
    ...(features.value.recordNavigation !== false
      ? [
          { label: t('dataviews.record.previous'), icon: 'i-lucide-chevron-left', iconOnly: true, disabled: position.value <= 0, onSelect: () => step(-1) },
          { label: t('common.next'), icon: 'i-lucide-chevron-right', iconOnly: true, disabled: position.value === -1 || position.value >= pkOrder.value.length - 1, onSelect: () => step(1) }
        ]
      : [])
  ]
})
// --- Search, Copy, Print, Activity - as the DataView's features say --------------------

const features = computed(() => resolveFeatures(props.dataview.viewType, config.value))
const outputs = useRecordOutputs({ dataview: toRef(props, 'dataview'), fields: toRef(props, 'fields') })
const searchOpen = ref(false)
const historyOpen = ref(false)
/**
 * What a FORM's record Search reads, shows per result and searches in: the key
 * and the page's first text fields, top to bottom (Specification_Data_API.md §3.5).
 */
const searchLabelFields = computed(() => {
  const columns = props.fields.filter(f => f.kind === 'COLUMN' && f.columnName)
  const textColumns = props.fields
    .filter(f => f.widget === 'UFormField' && fieldColumn(f))
    .sort((a, b) => a.gridY - b.gridY)
    .filter(f => ['UInput', 'UTextarea'].includes(fieldInput(props.fields, f.id)?.widget ?? ''))
    .map(f => columns.find(c => c.columnName === fieldColumn(f)))
    .slice(0, 3)
  const key = columns.find(c => c.columnName === primaryKey.value)
  return [key, ...textColumns].filter((f, i, all): f is DataViewField => Boolean(f) && all.indexOf(f) === i)
})
const canSearch = computed(() => !isMasterDetail.value && formMode.value !== 'CREATE' && !isSingle.value && features.value.search !== false && Boolean(primaryKey.value))

/** What the viewer's grants and the DataView's Allow let them do (the App's viewerActions) - a READ form never writes. */
const mayCreate = computed(() => formMode.value !== 'READ' && props.dataview.viewerActions?.create !== false)
const mayDelete = computed(() => formMode.value !== 'READ' && props.dataview.viewerActions?.delete !== false)
/** New: whoever may create rows here - a FORM read-only at rest still starts a new record (Beta_Findings 3.18). */
const offersNew = computed(() => props.dataview.viewerActions?.create !== false)
/** Delete, then the next record of the browse (or the previous one) - a blank form only when none is left (T65). */
/**
 * Its host's close (a delete, a page's dataview.close()): back where it came from - or, opened on its own (a link, a
 * new tab, no history to go back to), its DataView's list.
 */
function closePage() {
  const back = (window.history.state as { back?: string | null } | null)?.back
  if (back) router.back()
  else void router.replace(`/app/dataviews/${props.dataview.slug}`)
}
async function deleteRecord() {
  const current = record.value
  if (!current) return
  const at = position.value
  if (!await current.delete()) return
  const neighbor = at >= 0 ? (pkOrder.value[at + 1] ?? pkOrder.value[at - 1]) : undefined
  if (neighbor !== undefined && formMode.value !== 'CREATE' && !isMasterDetail.value) await current.open(neighbor, false)
}
/** The DataView's own actions on this record (Specification_DataViews.md §3.7). */
const customActions = useRecordCustomActions(toRef(props, 'dataview'), record)
const headerMenu = computed<DropdownMenuItem[][]>(() => {
  const current = record.value
  // While editing, the record's actions step aside: Save & New is all its "⋮" holds.
  if (editingNow.value) {
    return showFooter.value && features.value.recordSaveAndNew !== false && !isSingle.value ? recordMenu({ saveAndNew: () => void onSaveAndNew() }, t) : []
  }
  if (!current) return []
  const saved = current.pk !== null && current.pk !== undefined
  return recordMenu({
    custom: customActions.items.value,
    clone: saved && !isSingle.value && mayCreate.value && features.value.recordClone ? () => current.clone() : undefined,
    copy: features.value.recordCopy !== false && !isSingle.value ? () => void outputs.copy(current.data, current.pk) : undefined,
    print: features.value.recordPrint !== false ? () => void outputs.print(current.data, current.pk) : undefined,
    activity: readsActivity.value && features.value.recordHistory !== false && saved ? () => (historyOpen.value = true) : undefined,
    // The one record is never deleted from here - whoever may: SQL, the Data API.
    delete: saved && !isSingle.value && mayDelete.value ? () => void deleteRecord() : undefined
  }, t)
})

// Ctrl/⌘+S saves, +Shift saves and starts a new one.
useRecordFormShortcuts(computed(() => showFooter.value), { onSave: () => void onSave(), onSaveAndNew: () => void onSaveAndNew() }, {
  saveAndNew: computed(() => features.value.recordSaveAndNew && !isSingle.value)
})
</script>

<template>
  <PageShell
    :embedded="preview"
    :scroll="!fitToScreen"
  >
    <template
      v-if="!preview"
      #header
    >
      <PageHeader
        :title="dataview.name"
        :description="dataview.description ?? undefined"
        :icon="dataviewIcon(dataview)"
        :actions="headerActions"
        :menu="headerMenu"
      >
        <UButton
          v-if="record?.mode === 'view'"
          :label="t('common.edit')"
          icon="i-lucide-pencil"
          @click="record.edit()"
        />
        <UButton
          v-if="(formMode !== 'CREATE' || isMasterDetail) && !isSingle && !editingNow && offersNew"
          :label="newLabel"
          icon="i-lucide-plus"
          :color="started ? 'neutral' : 'primary'"
          :variant="started ? 'subtle' : 'solid'"
          @click="onNew"
        />
      </PageHeader>
    </template>

    <div :class="[contentClass, fitToScreen ? 'h-full' : undefined]">
      <UEmpty
        v-if="!started"
        icon="i-lucide-file-plus"
        :title="newLabel"
        :description="t('dataviews.record.startOne', { name: dataview.name })"
        :actions="[{ label: newLabel, icon: 'i-lucide-plus', onClick: onNew }]"
      />
      <CustomPage
        v-else
        :dataview="dataview"
        :fields="fields"
        :params="pageParams"
        :record-view="formMode === 'READ' && !isMasterDetail"
        :preview="preview"
        @ready="onReady"
        @close="closePage"
      />
    </div>

    <template
      v-if="showFooter && !preview"
      #footer
    >
      <RecordFormFooter
        :saving="saving"
        @cancel="onCancel"
        @save="onSave"
      />
    </template>

    <RecordSearchSidebar
      v-if="canSearch"
      v-model:open="searchOpen"
      :schema="table.schema"
      :resource-name="table.name"
      :resource-kind="table.kind"
      :primary-key="primaryKey!"
      :label-fields="searchLabelFields"
      @select="(pk: string) => { searchOpen = false; void openRecord(pk) }"
    />
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
  </PageShell>
</template>
