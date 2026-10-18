/**
 * The Code tab's Reference (Specification_DataViews.md §11.1):
 * what a handler's `dataview` holds, as the live page builds it
 * (useWidgetRuntime.ts) - each entry its signature, what it does and a line
 * to insert. Plain data: a new runtime member means a new entry here.
 *
 * Texts are keys under `designer.customCodeReference.<section>` (Specification_Admin_UI.md §14):
 * `title`, `description` and `entries.<entry>`; signatures and examples are
 * code and stay as written. `params` fill a text's code fragments.
 */

export interface CodeReferenceEntry {
  /** Its description's key, under its section's `entries`. */
  key: string
  signature: string
  params?: Record<string, string>
  /** Inserted at the cursor - a line that works as written once the names are yours. */
  example?: string
}

export interface CodeReferenceSection {
  /** Its texts' key, under `designer.customCodeReference`. */
  key: string
  titleParams?: Record<string, string>
  /** Whether it has a `description` text. */
  described?: boolean
  entries: CodeReferenceEntry[]
}

export const CODE_REFERENCE_KEY = 'designer.customCodeReference'

export const CODE_REFERENCE: readonly CodeReferenceSection[] = [
  {
    key: 'handlers',
    described: true,
    entries: [
      { key: 'handler', signature: 'async function name(dataview, event)' },
      { key: 'onLoad', signature: 'function onLoad(dataview)' }
    ]
  },
  {
    key: 'variables',
    titleParams: { code: 'dataview.vars.<name>' },
    described: true,
    entries: [
      { key: 'value', signature: 'Value: .value · .set(v) · .reset()', example: 'dataview.vars.name.set(1)' },
      {
        key: 'resource',
        signature: 'Resource: .data · .count · .status · .refresh() · .setFilter(where) · .clearFilter() · .setSearch(text) · .setOrder(by) · .setPage(n) · .find(column, value)',
        example: 'await dataview.vars.name.setFilter({ status: { _eq: \'OPEN\' } })'
      },
      {
        key: 'call',
        signature: 'Call: .execute(input) · .data · .error · .clear()',
        params: { errors: '{ errors }' },
        example: 'const result = await dataview.vars.name.execute({ data: {} })'
      }
    ]
  },
  {
    key: 'record',
    titleParams: { code: 'dataview.vars.record' },
    described: true,
    entries: [
      { key: 'data', signature: '.data · .pk · .mode · .dirty' },
      { key: 'save', signature: '.save(values?)', example: 'await dataview.vars.record.save({ status: \'DONE\' })' },
      { key: 'set', signature: '.set(column, value)', example: 'dataview.vars.record.set(\'column\', value)' },
      { key: 'other', signature: '.new(values?) · .open(pk, view?) · .edit() · .cancel() · .delete()' },
      { key: 'refresh', signature: '.refresh() · .reload()', example: 'await dataview.vars.record.refresh()' },
      { key: 'canEdit', signature: '.canEdit(column)' }
    ]
  },
  {
    key: 'controls',
    titleParams: { code: 'dataview.controls.<name>' },
    described: true,
    entries: [
      { key: 'open', signature: '.open() · .close() · .focus()', example: 'dataview.controls.name.open()' },
      { key: 'form', signature: '.submit() · .validate() · .clear() · .data', params: { data: '{ data }' } },
      { key: 'result', signature: '.show({ color, icon, title, description, sound, resetAfter }) · .reset()', example: 'dataview.controls.result.show({ color: \'success\', title: \'Welcome\' })' },
      { key: 'locate', signature: '.locate()', example: 'await dataview.controls.map.locate()' }
    ]
  },
  {
    key: 'page',
    entries: [
      { key: 'notify', signature: 'dataview.notify(message, color?)', example: 'dataview.notify(\'Saved\', \'success\')' },
      {
        key: 'confirm',
        signature: 'await dataview.confirm(question)',
        params: { shape: '{ title, lines, confirm, color }' },
        example: 'if (!(await dataview.confirm(\'Continue?\'))) return'
      },
      { key: 'format', signature: 'dataview.format.number(v, decimals) · .currency(v, code) · .date(v) · .time(v) · .datetime(v)', example: 'dataview.format.number(total, 2)' },
      { key: 'params', signature: 'dataview.params' },
      { key: 'openDataView', signature: 'dataview.openDataView(slug, params?, { newTab })', example: 'dataview.openDataView(\'slug\', { pk: id })' },
      { key: 'openFile', signature: 'dataview.openFile(result)', example: 'dataview.openFile(result)' },
      { key: 'device', signature: 'await dataview.device.location({ highAccuracy, timeout })', example: 'const { lng, lat } = await dataview.device.location()' }
    ]
  }
]
