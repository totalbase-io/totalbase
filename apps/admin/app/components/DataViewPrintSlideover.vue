<script setup lang="ts">
/**
 * The grid's Print panel (features.print): paper size, orientation, font
 * size, columns, and an optional header (title/description/active filter,
 * repeated on every page) and footer (printed-at + "Page X of Y"). It
 * generates a table PDF (jsPDF + jspdf-autotable, loaded on first use)
 * and hands it straight to the browser's print dialog through an
 * off-screen iframe - no separate preview step. Props in, events out
 * (AGENTS.md section 21A), same contract as DataViewExportSlideover.
 */
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import type { DataViewField } from '~/types/dataview'
import type { ColumnChecklistItem } from '~/components/DataViewColumnChecklist.vue'
import { formatCellPlainText } from '~/utils/build-dataview-columns'

const props = defineProps<{
  fields: DataViewField[]
  orderedFields: DataViewField[]
  rows: Record<string, unknown>[]
  total: number
  /** dataviews.print_max_rows. */
  cap: number
  /** dataviews.print_warning_threshold. */
  warningThreshold: number
  displayFormatDefaults: DisplayFormatDefaults
  fetchAll: (cap: number) => Promise<{ rows: Record<string, unknown>[], truncated: boolean }>
  /** The header's three lines - each printed even when empty, so the table never shifts. */
  title: string
  description: string
  filterSummary: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ printed: [rowCount: number] }>()

const toast = useToast()
const dates = useDateTimeFormat()
const { t } = useI18n()
const ui = useUiLocale()
const notifyError = useErrorToast()
const PRINT_MARGIN = 40

const paperSize = ref<'a4' | 'letter'>('a4')
const orientation = ref<'portrait' | 'landscape'>('portrait')
const fontSize = ref(9)
const scope = ref<'page' | 'all'>('page')
const withHeader = ref(true)
const withFooter = ref(true)
const columns = ref<ColumnChecklistItem[]>([])
const paperItems = computed(() => (['a4', 'letter'] as const).map(value => ({ label: t(`dataviews.print.paper.${value}`), value })))
const orientationItems = computed(() => (['portrait', 'landscape'] as const).map(value => ({ label: t(`dataviews.print.orientations.${value}`), value })))
const pdfUrl = ref<string | null>(null)
const generating = ref(false)
/** Its own @load calls print() the moment a freshly generated PDF loads. */
const frameRef = ref<HTMLIFrameElement | null>(null)

function releasePdf() {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value)
  pdfUrl.value = null
}
watch(open, (isOpen) => {
  if (!isOpen) return releasePdf()
  scope.value = 'page'
  withHeader.value = true
  withFooter.value = true
  columns.value = props.orderedFields
    .filter(f => f.columnName)
    .map(f => ({ key: f.columnName!, label: f.label ?? f.columnName!, selected: true }))
}, { immediate: true })
onBeforeUnmount(releasePdf)

/**
 * The header goes through autoTable's didDrawPage, so it repeats on every
 * page. The footer can't: "Page X of Y" needs the total page count, which
 * only exists once autoTable is done - a second pass over the drawn pages.
 */
async function printPdf() {
  // In the checklist's order - the grid's own (orderedFields: the viewer's column order), not the design's.
  const cols = columns.value
    .filter(c => c.selected)
    .map(c => props.fields.find(f => f.columnName === c.key))
    .filter((f): f is DataViewField => !!f)
  if (!cols.length) return
  generating.value = true
  try {
    let sourceRows = props.rows
    if (scope.value === 'all') {
      const result = await props.fetchAll(props.cap)
      sourceRows = result.rows
      if (result.truncated) {
        toast.add({ title: t('dataviews.print.truncatedTitle', { count: props.cap.toLocaleString(ui.intlLocale.value) }), description: t('dataviews.export.truncatedDescription'), color: 'warning' })
      }
    }
    const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
    const autoTable = autoTableModule.default
    const doc = new jsPDF({ orientation: orientation.value, unit: 'pt', format: paperSize.value })
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const lineHeight = fontSize.value + 6
    // Only the lines that have text take room under the title - no blank gap for a missing description or filter.
    const description = props.description.trim()
    const filterSummary = props.filterSummary.trim()
    const extraLines = (description ? 1 : 0) + (filterSummary ? 1 : 0)
    const headerHeight = withHeader.value ? PRINT_MARGIN + lineHeight * extraLines : PRINT_MARGIN - 10
    const footerHeight = withFooter.value ? 30 : 10

    function drawHeader() {
      if (!withHeader.value) return
      let y = PRINT_MARGIN - 10
      doc.setFontSize(fontSize.value + 4)
      doc.setFont('helvetica', 'bold')
      doc.text(props.title, PRINT_MARGIN, y)
      y += lineHeight
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(fontSize.value)
      if (description) {
        doc.text(description, PRINT_MARGIN, y)
        y += lineHeight
      }
      if (filterSummary) {
        doc.setFontSize(fontSize.value - 1)
        doc.setTextColor(120)
        doc.text(filterSummary, PRINT_MARGIN, y)
        doc.setTextColor(0)
        doc.setFontSize(fontSize.value)
      }
    }

    autoTable(doc, {
      startY: headerHeight,
      margin: { top: headerHeight, bottom: footerHeight },
      styles: { fontSize: fontSize.value },
      head: [cols.map(f => f.label ?? f.columnName!)],
      body: sourceRows.map(row => cols.map(f => formatCellPlainText(f, row[f.columnName!], row, props.displayFormatDefaults))),
      didDrawPage: drawHeader
    })

    if (withFooter.value) {
      const printedAt = dates.dateTime(new Date())
      // `getNumberOfPages` is real at runtime (jsPDF's own `internal`) but missing from its .d.ts.
      const pageCount = (doc.internal as unknown as { getNumberOfPages: () => number }).getNumberOfPages()
      doc.setFontSize(8)
      doc.setTextColor(120)
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i)
        doc.text(printedAt, PRINT_MARGIN, pageHeight - 15)
        doc.text(t('dataviews.print.pageOf', { page: i, pages: pageCount }), pageWidth - PRINT_MARGIN, pageHeight - 15, { align: 'right' })
      }
      doc.setTextColor(0)
    }

    releasePdf()
    pdfUrl.value = URL.createObjectURL(doc.output('blob'))
    emit('printed', sourceRows.length)
  } catch (err) {
    notifyError(err, t('dataviews.print.error'))
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('dataviews.meta.featureLabels.print')"
  >
    <template #body>
      <div class="flex h-full flex-col gap-4">
        <UFormField :label="t('dataviews.history.rows')">
          <URadioGroup
            v-model="scope"
            :items="[{ label: t('dataviews.export.thisPage'), value: 'page' }, { label: t('dataviews.export.allRows', { count: cap.toLocaleString(ui.intlLocale.value) }), value: 'all' }]"
          />
        </UFormField>
        <!-- Only "All matching rows" can ever exceed the threshold - "This page" is always bounded by pageSize. -->
        <UAlert
          v-if="scope === 'all' && total > warningThreshold"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('dataviews.print.slowWarning')"
        />
        <div class="flex flex-col gap-2">
          <USwitch
            v-model="withHeader"
            :label="t('dataviews.print.header')"
            :description="t('dataviews.print.headerDescription')"
          />
          <USwitch
            v-model="withFooter"
            :label="t('dataviews.print.footer')"
            :description="t('dataviews.print.footerDescription')"
          />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <UFormField :label="t('dataviews.print.paperSize')">
            <USelectMenu
              v-model="paperSize"
              :items="paperItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('dataviews.print.orientation')">
            <USelectMenu
              v-model="orientation"
              :items="orientationItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('dataviews.print.fontSize')"
            class="col-span-2"
          >
            <UInput
              v-model.number="fontSize"
              type="number"
              min="6"
              max="18"
            />
          </UFormField>
        </div>
        <UFormField :label="t('dataviews.meta.featureLabels.columnsToggle')">
          <DataViewColumnChecklist
            v-model="columns"
            max-height="max-h-48"
          />
        </UFormField>
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          class="mt-auto"
          :title="t('dataviews.print.helpTitle')"
          :description="t('dataviews.print.helpDescription')"
        />
        <!-- Off-screen (not display:none, which some browsers won't render
        a PDF into), #toolbar=0: nothing of it is ever shown - its @load
        opens the browser's print dialog. -->
        <iframe
          v-if="pdfUrl"
          ref="frameRef"
          :src="`${pdfUrl}#toolbar=0`"
          class="fixed left-[-10000px] top-0 h-[800px] w-[600px] border-0"
          aria-hidden="true"
          tabindex="-1"
          @load="frameRef?.contentWindow?.print()"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.close')"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
        <UButton
          :label="t('dataviews.meta.featureLabels.print')"
          icon="i-lucide-printer"
          :disabled="!columns.some(c => c.selected)"
          :loading="generating"
          @click="printPdf"
        />
      </div>
    </template>
  </USlideover>
</template>
