import type { Ref } from 'vue'
import type { DataView, DataViewField } from '~/types/dataview'
import { recordAsText } from '~/utils/record-copy'
import { printRecordPdf } from '~/utils/record-print'
import { fieldColumn } from '~/utils/widget-form'
import { resolveFieldPresentation } from '~/utils/field-presentation'
import { displayColumns, displayFieldAlias, type DisplayConfig } from '~/utils/display-field'

/**
 * What can be done with a record beyond editing it - Copy (its values as
 * text, "Field: value" one per line) and Print - for the one open in a form
 * (DataViewRecordPanel.vue, DataViewRecordPage.vue) or a grid's row or card
 * (DataViewGrid.vue): the values are passed in. Both read the fields the
 * record's page shows, in its order and with its labels, formatted as the
 * grid's columns format them.
 */
export function useRecordOutputs(options: {
  dataview: Ref<DataView>
  fields: Ref<DataViewField[]>
}) {
  const toast = useToast()
  const { t } = useI18n()
  const ui = useUiLocale()
  const { printBlob } = usePrintBlob()
  const { defaults: displayFormatDefaults } = useDisplayFormatDefaults()
  const dataApi = useDataApi()

  /** The columns the page's form fields are bound to, in their order, labelled as on the page - else the visible columns. */
  const printedFields = computed<DataViewField[]>(() => {
    // Each column titled as it shows - its table column's (Specification_DataViews.md §15).
    const resolved = options.fields.value.map(resolveFieldPresentation)
    const columns = new Map(resolved.filter(f => f.kind === 'COLUMN' && f.columnName).map(f => [f.columnName!, f]))
    const onPage = options.fields.value
      .filter(f => f.widget === 'UFormField' && fieldColumn(f))
      .sort((a, b) => a.gridY - b.gridY)
      .flatMap((f) => {
        const column = columns.get(fieldColumn(f)!)
        const label = (f.config as { props?: { label?: string } }).props?.label
        return column ? [{ ...column, label: label || column.label }] : []
      })
    return onPage.length ? onPage : resolved.filter(f => f.kind === 'COLUMN' && f.visible)
  })

  /**
   * The values with what each foreign key shows (`provincia.nombre`), as a grid's row already has them: a form's
   * record is read without, so they're read once from the saved row - and used only while the key is still the
   * saved one (an unsaved pick shows its key until it's saved). Best effort: on a failure, the values as they are.
   */
  async function withShownValues(values: Record<string, unknown>, pk: unknown): Promise<Record<string, unknown>> {
    const missing = printedFields.value.flatMap((f) => {
      const config = f.config as DisplayConfig & { display_field_denied?: boolean } | undefined
      if (f.kind !== 'COLUMN' || !f.columnName || !config?.display_field || config.display_field_denied) return []
      return displayColumns(config).map(c => ({ fk: f.columnName!, alias: displayFieldAlias(f.columnName!, c) })).filter(m => !(m.alias in values))
    })
    const dv = options.dataview.value
    const pkColumn = dv.sourceResourcePrimaryKey?.length === 1 ? dv.sourceResourcePrimaryKey[0]! : null
    if (!missing.length || pk === null || pk === undefined || !pkColumn || !dv.sourceResourceSchema || !dv.sourceResourceName) return values
    try {
      const path = dataApi.resourcePath(dv.sourceResourceSchema, dv.sourceResourceName, dv.sourceResourceType === 'VIEW' ? 'view' : 'table')
      const fks = [...new Set(missing.map(m => m.fk))]
      const { data } = await dataApi.get<Record<string, unknown>[]>(path, {
        fields: [...fks, ...missing.map(m => m.alias)].join(','),
        [`where[${pkColumn}][_eq]`]: String(pk),
        limit: 1
      })
      const saved = data[0]
      if (!saved) return values
      const shown = Object.fromEntries(missing.filter(m => saved[m.fk] === values[m.fk]).map(m => [m.alias, saved[m.alias]]))
      return { ...values, ...shown }
    } catch {
      return values
    }
  }

  async function copy(values: Record<string, unknown>, pk?: unknown) {
    try {
      values = await withShownValues(values, pk)
      await navigator.clipboard.writeText(recordAsText(values, printedFields.value, displayFormatDefaults.value))
      toast.add({ title: t('common.copied'), color: 'success' })
    } catch {
      toast.add({ title: t('dataviews.record.copyError'), color: 'error' })
    }
  }

  async function print(values: Record<string, unknown>, pk: unknown) {
    values = await withShownValues(values, pk)
    printBlob(await printRecordPdf({
      dataviewTitle: options.dataview.value.name,
      dataviewDescription: options.dataview.value.description ?? '',
      recordLabel: pk === null || pk === undefined ? t('dataviews.record.printNewLabel') : t('dataviews.record.printLabel', { pk: String(pk) }),
      fields: printedFields.value,
      values,
      displayFormatDefaults: displayFormatDefaults.value,
      labels: {
        field: t('dataviews.record.printField'),
        value: t('common.value'),
        page: (page, pages) => t('dataviews.print.pageOf', { page, pages }),
        // Numbers and dates in the browser's regional format.
        locale: ui.intlLocale.value ?? navigator.language
      }
    }))
  }

  return { printedFields, copy, print }
}
