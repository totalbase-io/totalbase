/**
 * The runtime of a CUSTOM page (DataViews.md §13.1):
 * its variables engine, its compiled Code and its controls, handed to every
 * placed widget through `provide` (WidgetRenderer.vue) - one page, one
 * runtime, whether it's the App, the Design form's Preview or a canvas card
 * (`mode: 'design'`, no data and no code).
 *
 * Every read and write goes through the Data API and the function/workflow
 * routes as the viewer - the page never widens what they may do.
 */
import { foreignKeyDisplay } from '~/utils/foreign-key-display'
import type { ColumnPresentation, TableCallAction, VariableDefinition } from '@totalbase/tb-catalog'
import type { Component, ComputedRef, InjectionKey, Ref } from 'vue'
import type { DataView, DataViewField } from '~/types/dataview'
import { withRelatedPresentation } from '~/utils/widget-table'
import { compileCustomCode, declaredFunctions, runHandler } from '~/utils/custom-code'
import { toDataApiParams } from '~/utils/data-api-query'
import { createPageFormat, type PageFormat } from '~/utils/page-format'
import { AdminApiError } from '~/utils/admin-api-error'
import { createRecord, type RecordCatalog, type RecordHandle } from '~/utils/record-engine'
import { createVariablesEngine, formulaTypeFor, type ValueHandle, type VariableHandle, type VariablesTransport } from '~/utils/variables-engine'
import { loadFormulaFunctions } from '~/utils/formula-engine'
import { evaluateWidgetFormula } from '~/utils/widget-formula'
import { fieldColumn, fieldJunction } from '~/utils/widget-form'
import { createJunctionLinks, type JunctionCatalog, type JunctionLinksHandle } from '~/utils/junction-links'
import { currentLocation } from '~/utils/device-location'

export interface WidgetControl {
  open?: () => void
  close?: () => void
  focus?: () => void
  /** A UForm's: validate and emit submit; validate only; clear its errors. */
  submit?: () => Promise<void> | undefined
  validate?: () => Promise<unknown> | undefined
  clear?: () => void
  /** A Result's (TResult): show an outcome - `{ color, icon, title, description, sound, resetAfter }`, or a title alone -; back to waiting. */
  show?: (options?: Record<string, unknown> | string) => void
  reset?: () => void
  /** A map field's or a Location's: the device's position into its value. */
  locate?: () => Promise<void> | undefined
  /** A UForm's data, in the API's envelope: `{ data: { field: value } }`. */
  readonly data?: { data: Record<string, unknown> }
  /** Its state (widgetState, DataViews.md §9.1) - also `{{controls.<name>.*}}` in formulas: what it holds, an option list's chosen row, a Table's last row clicked. */
  readonly value?: unknown
  readonly item?: Record<string, unknown> | null
  readonly row?: Record<string, unknown> | null
}

type NotifyColor = 'success' | 'info' | 'warning' | 'error' | 'neutral'

export interface WidgetRuntime {
  mode: 'design' | 'live'
  /** Every placed widget of the page. */
  fields: ComputedRef<DataViewField[]>
  vars: Record<string, VariableHandle>
  /** Named widgets that expose methods or state, by name - `dataview.controls.<name>`, `{{controls.<name>.*}}`. */
  controls: Record<string, WidgetControl>
  /** Runs Code function `handler` with `(dataview, event)`, awaited. */
  emit: (handler: string, event: Record<string, unknown>) => Promise<unknown>
  notify: (message: string, color?: NotifyColor) => void
  /** The page's record, when its DataView has a source table - what a form field bound to a column edits. */
  record?: RecordHandle
  /**
   * Its form fields linked through a junction table (DataViews.md §8.5), by the field's id: the links they edit -
   * null where the viewer may not read the junction, or it isn't one of the record's any more; absent while it loads.
   */
  junctions?: Record<string, JunctionLinksHandle | null>
  /** A Resource variable's columns, name → PostgreSQL type - how a Table formats its rows. */
  resourceColumns?: (variable: string) => Record<string, string> | undefined
  /** The fields a Resource variable reads, in its query's order - a Table's columns, rows or not. */
  resourceFields?: (variable: string) => string[] | undefined
  /** What a Resource variable's resource columns set (DataViews.md §15) - what a Table's columns inherit. */
  resourcePresentation?: (variable: string) => Record<string, ColumnPresentation> | undefined
  /**
   * A Resource variable's foreign keys as they show (DataViews.md §15.5) - for `rows`, by column, each
   * key's text from its table's row presentation, read under the viewer's own grants: a table they may not read
   * leaves its keys as they are.
   */
  foreignKeyLabels?: (variable: string, rows: Record<string, unknown>[]) => Promise<Record<string, Record<string, string>>>
  /** What a column of the page's record table sets - what a form field bound to it inherits: its label, description, help, its input's placeholder and icon, its values' labels. */
  recordPresentation?: (column: string) => ColumnPresentation | undefined
  /** `dataview.format` - the viewer's number, date and time formats. */
  format?: PageFormat
  /**
   * The Design form's canvas area (CustomCanvasArea.vue): when set, a
   * widget's inline slots are drawn as areas to drop into, with props
   * `{ parent, slotName, label }`.
   */
  designArea?: Component
}

/** A Resource's query `fields` in order (`"id,name"`) - all of its columns when it names none. */
export function queryFields(fields: unknown, columns: Record<string, string> | undefined): string[] {
  const named = typeof fields === 'string' ? fields.split(',').map(f => f.trim()).filter(Boolean) : []
  return named.length ? named : Object.keys(columns ?? {})
}

export const WIDGET_RUNTIME_KEY: InjectionKey<WidgetRuntime> = Symbol('widget-runtime')

/** A canvas card's runtime: widgets drawn with their literal props only - and a Table its Resource's columns (`resourceFields`, `resourceColumns`), never its rows. */
export function designRuntime(fields: ComputedRef<DataViewField[]>, designArea?: Component, resources: Pick<WidgetRuntime, 'resourceFields' | 'resourceColumns' | 'resourcePresentation' | 'recordPresentation'> = {}): WidgetRuntime {
  return { mode: 'design', fields, vars: {}, controls: {}, emit: async () => undefined, notify: () => {}, designArea, ...resources }
}

interface FileResult { asset?: string, filename?: string, mimeType?: string, content?: string }
interface WorkflowRunResult { id: string, status: string, result: { data?: unknown } | null, error: { code: string, message: string } | null }

/**
 * A live page: builds the engine from the DataView's variables, compiles
 * its Code, and returns the runtime to `provide` plus `start()` - loads the
 * immediate Resources, then runs the Code's `onLoad(dataview)` if it
 * declares one.
 */
export interface ConfirmOptions {
  title?: string
  lines?: readonly unknown[]
  /** The confirming button's label. */
  confirm?: string
  /** `error` for what can't be undone (a delete) - the confirming button's color. */
  color?: 'primary' | 'error'
}

export interface PageDialogs {
  confirm: { title: string, lines: string[], confirm: string, color: 'primary' | 'error', resolve: (ok: boolean) => void } | null
  file: { blob: Blob, url: string, filename: string } | null
}

export interface CustomPageOptions {
  /** URL parameters: a Value's default may read them; `pk` opens that record. */
  params?: Record<string, unknown>
  /** The Design form's Preview: a Call asks before it runs, the record reads the draft's table as an administrator. */
  preview?: boolean
  /** `record.close()` - the host's. */
  onClose?: () => void
  /** The record opens read-only (a FORM's READ mode) until `edit()`. */
  recordView?: boolean
}

export function useCustomPage(dataview: Ref<DataView>, fields: Ref<DataViewField[]>, options: CustomPageOptions = {}) {
  const dataApi = useDataApi()
  const adminApi = useAdminApi()
  const appApi = useAppApi()
  const filesApi = useFilesApi()
  const session = useSession()
  const toast = useToast()
  const router = useRouter()
  const { t } = useI18n()
  const apiErrorText = useApiErrorText()
  const { timezone } = useDateTimeFormat()
  const format = createPageFormat(() => ({ timezone: timezone.value ?? '' }))

  const definitions = (dataview.value.viewConfig.variables ?? []) as VariableDefinition[]
  const resources = dataview.value.variableResources ?? {}
  const workflows = dataview.value.variableWorkflows ?? {}
  const compiled = computed(() => compileCustomCode(dataview.value.code ?? '', declaredFunctions(dataview.value.code ?? '')))
  const controls = reactive<Record<string, WidgetControl>>({})
  /** What CustomPage.vue shows over the page: a confirmation, a file's preview. */
  const dialogs = reactive<PageDialogs>({ confirm: null, file: null })

  function notify(message: string, color: NotifyColor = 'info') {
    toast.add({ title: message, color })
  }

  async function openFile(result: unknown) {
    const file = result as FileResult | null
    let blob: Blob | null = null
    let filename = file?.filename || 'document'
    if (typeof file?.asset === 'string') {
      const stored = await filesApi.download(file.asset)
      blob = stored.blob
      filename = file.filename || stored.filename
    } else if (typeof file?.mimeType === 'string' && typeof file.content === 'string') {
      blob = new Blob([Uint8Array.from(atob(file.content), c => c.charCodeAt(0))], { type: file.mimeType })
    }
    if (!blob) return notify(t('designer.useWidgetRuntime.notAFile'), 'warning')
    const url = URL.createObjectURL(blob)
    // A PDF or an image opens in the page's preview (Print, Download); anything else downloads.
    if (blob.type === 'application/pdf' || blob.type.startsWith('image/')) {
      if (dialogs.file) URL.revokeObjectURL(dialogs.file.url)
      dialogs.file = { blob, url, filename }
      return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  /**
   * `dataview.confirm(question)` - the page's own dialog, resolving to whether
   * the viewer confirmed. A text (its lines as lines), or `{ title, lines,
   * confirm }` for a titled summary with its own button ("Emitir").
   */
  function confirm(question: string | ConfirmOptions): Promise<boolean> {
    const options = typeof question === 'string' ? { lines: question.split('\n') } : question
    dialogs.confirm?.resolve(false)
    return new Promise((resolve) => {
      dialogs.confirm = {
        title: options.title ?? t('common.confirm'),
        lines: (options.lines ?? []).map(String),
        confirm: options.confirm ?? t('designer.useWidgetRuntime.ok'),
        color: options.color ?? 'primary',
        resolve: (ok: boolean) => {
          dialogs.confirm = null
          resolve(ok)
        }
      }
    })
  }

  /**
   * A table Call, through the Data API: the input is the body, plus the row
   * an update or delete acts on - `pk` in the URL, `where` in the query,
   * as the API takes them. Never every row by omission.
   */
  async function writeTable(resourceId: string, action: TableCallAction, input: Record<string, unknown>): Promise<unknown> {
    const table = resources[resourceId]
    if (!table) throw new Error(t('designer.useWidgetRuntime.tableNotAvailable'))
    const { pk, where, ...body } = input
    const path = (key?: unknown) => dataApi.resourcePath(table.schema, table.name, 'table', key === undefined || key === null ? undefined : String(key))
    if (action === 'CREATE') return (await dataApi.post<unknown>(path(), body)).data
    if ((pk === undefined || pk === null) && !isFilter(where)) throw new Error(action === 'UPDATE' ? t('designer.useWidgetRuntime.updateNamesRow') : t('designer.useWidgetRuntime.deleteNamesRow'))
    const query = pk === undefined || pk === null ? toDataApiParams({ where }) : undefined
    if (action === 'UPDATE') return (await dataApi.patch<unknown>(path(pk), body, query)).data
    return (await dataApi.del<unknown>(path(pk), query)).data
  }
  function isFilter(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  }

  const transport: VariablesTransport = {
    async read(resourceId, query) {
      const resource = resources[resourceId]
      if (!resource) throw new Error(t('designer.useWidgetRuntime.resourceNotAvailable'))
      const path = dataApi.resourcePath(resource.schema, resource.name, resource.type === 'VIEW' ? 'view' : 'table')
      const { data, meta } = await dataApi.get<unknown[]>(path, toDataApiParams(query))
      return { data, count: meta?.count as number | undefined }
    },
    // A Call's input is the request body as the API takes it - { data: {...} } (Data_API.md §2.4).
    async call(target, input) {
      const question = target.type === 'WORKFLOW'
        ? t('designer.useWidgetRuntime.runWorkflow', { name: workflows[target.workflow]?.name ?? '' })
        : target.type === 'TABLE'
          ? t(target.action === 'CREATE' ? 'designer.useWidgetRuntime.runCreate' : target.action === 'UPDATE' ? 'designer.useWidgetRuntime.runUpdate' : 'designer.useWidgetRuntime.runDelete', { name: resources[target.resource]?.name ?? '' })
          : t('designer.useWidgetRuntime.runFunction', { name: resources[target.resource]?.name ?? '' })
      if (options.preview && !await confirm({ title: t('common.preview'), lines: [question], confirm: t('designer.useWidgetRuntime.runIt') })) throw new Error(t('designer.useWidgetRuntime.cancelledInPreview'))
      if (target.type === 'WORKFLOW') {
        const workflow = workflows[target.workflow]
        if (!workflow) throw new Error(t('designer.useWidgetRuntime.workflowNotAvailable'))
        // The run's outcome { id, status, result, error } (Workflows.md §13.1) - never its steps.
        const { data } = await dataApi.post<WorkflowRunResult>(`/workflows/${encodeURIComponent(workflow.slug)}/run`, input)
        if (data.status === 'FAILED') throw new Error(data.error?.message ?? t('designer.useWidgetRuntime.workflowFailed'))
        return data.result?.data ?? null
      }
      if (target.type === 'TABLE') return writeTable(target.resource, target.action, input)
      const fn = resources[target.resource]
      if (!fn) throw new Error(t('designer.useWidgetRuntime.functionNotAvailable'))
      const { data } = await dataApi.post<unknown>(`/${fn.schema}/function/${fn.name}`, input)
      return data
    }
  }

  /**
   * `dataview.openDataView(slug, params, { newTab })` - another DataView of the
   * App, with `params` as its URL's query (`pk` opens that record). From the
   * Preview it always opens in a new tab, leaving the Design form in place.
   */
  function openDataView(slug: string, params: Record<string, unknown> = {}, open: { newTab?: boolean } = {}) {
    const query = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]))
    const target = { path: `/app/dataviews/${encodeURIComponent(slug)}`, query }
    if (open.newTab || options.preview) window.open(router.resolve(target).href, '_blank')
    else void navigateTo(target)
  }

  // The context every handler receives as `dataview` - assigned once the engine exists.
  const context: Record<string, unknown> = {}

  function emitHandler(handler: string, event: Record<string, unknown>): Promise<unknown> {
    return runHandler(compiled.value, handler, [context, event], message => notify(message, 'error'))
  }

  // --- The record: a row of the DataView's source table (DataViews.md §8.5) ---

  const recordTable = dataview.value.sourceResource && dataview.value.sourceResourceType === 'TABLE' && dataview.value.sourceResourceSchema && dataview.value.sourceResourceName
    ? { id: dataview.value.sourceResource, schema: dataview.value.sourceResourceSchema, name: dataview.value.sourceResourceName }
    : null
  /** The columns a read asks for - those the catalog says the viewer may read. */
  let recordFields = ''
  const recordEmits = (dataview.value.viewConfig.record as { emits?: Record<string, string> } | undefined)?.emits ?? {}
  // Each record's version as last read or written (meta.version) - sent back as If-Match, so a save over someone
  // else's later change fails instead of overwriting it silently (T56, Data_API.md §5.3).
  const rowVersions = new Map<string, string>()
  function rememberVersion(pk: unknown, meta: Record<string, unknown> | undefined) {
    if (typeof meta?.version === 'string') rowVersions.set(String(pk), meta.version)
  }
  const record = recordTable
    ? createRecord({
        // Its notices (deleted, gone, confirm) in the UI's language.
        t,
        transport: {
          async catalog() {
            // The Preview shows a draft to an administrator: the table's whole record catalog, every column
            // writable - the server's computation, the same the App's route makes for a viewer.
            const catalog: RecordCatalog = options.preview
              ? (await adminApi.get<RecordCatalog>(`/catalog/table/${recordTable.id}/record`)).data
              : (await appApi.get<RecordCatalog>(`/dataviews/${dataview.value.id}/record`)).data
            recordFields = catalog.catalog.columns.map(c => c.name).join(',')
            return catalog
          },
          async read(pk) {
            try {
              const { data, meta } = await dataApi.get<Record<string, unknown>>(dataApi.resourcePath(recordTable.schema, recordTable.name, 'table', String(pk)), { fields: recordFields })
              rememberVersion(pk, meta)
              return data
            } catch (error) {
              if (error instanceof AdminApiError && error.status === 404) return null
              throw error
            }
          },
          create: async data => (await dataApi.post<Record<string, unknown>>(dataApi.resourcePath(recordTable.schema, recordTable.name), { data })).data,
          async update(pk, data) {
            try {
              const { data: row, meta } = await dataApi.patch<Record<string, unknown>>(dataApi.resourcePath(recordTable.schema, recordTable.name, 'table', String(pk)), { data }, undefined, { ifMatch: rowVersions.get(String(pk)) })
              rememberVersion(pk, meta)
              return row
            } catch (error) {
              // Changed by someone else since it was read: the error says so; saving again overwrites (T56).
              if (error instanceof AdminApiError && error.status === 409) rowVersions.delete(String(pk))
              throw error
            }
          },
          async remove(pk) {
            await dataApi.del(dataApi.resourcePath(recordTable.schema, recordTable.name, 'table', String(pk)), undefined, undefined, { ifMatch: rowVersions.get(String(pk)) })
            rowVersions.delete(String(pk))
          },
          table: { schema: recordTable.schema, name: recordTable.name },
          // With its lines, in one transaction (DataViews.md §6.6) - the DataView's own save.
          saveTogether: async operations => (await appApi.post<Record<string, Record<string, unknown>>>(`/dataviews/${dataview.value.id}/save`, { data: { operations } })).data
        },
        emit: (event, payload) => (recordEmits[event] ? emitHandler(recordEmits[event], payload) : undefined),
        notify,
        showsField: column => fields.value.some(f => f.widget === 'UFormField' && fieldColumn(f) === column),
        describe: apiErrorText,
        confirm: message => confirm({ title: t('common.delete'), lines: [message], confirm: t('common.delete'), color: 'error' }),
        close: () => (options.onClose ? options.onClose() : notify(t('designer.useWidgetRuntime.nothingToClose'), 'info'))
      })
    : null

  // --- Form fields linked through a junction table (DataViews.md §8.5): their links join the record's save ---

  const junctions = reactive<Record<string, JunctionLinksHandle | null>>({})
  const junctionLoads: ((pk: unknown) => Promise<void>)[] = []
  async function startJunctions() {
    if (!record) return
    const linked = fields.value.filter(f => f.kind === 'WIDGET' && fieldJunction(f))
    await Promise.all(linked.map(async (field, index) => {
      let junction: JunctionCatalog
      try {
        junction = (await appApi.get<JunctionCatalog>(`/dataviews/${dataview.value.id}/junctions/${fieldJunction(field)}`)).data
      } catch {
        junctions[field.id] = null
        return
      }
      const links = createJunctionLinks({
        junction,
        keyPrefix: `junction${index + 1}`,
        changed: () => record.handle.linesChanged(),
        async read(key) {
          // A record's links: as many as one save may write (dataviews.save_max_operations).
          const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(junction.schema, junction.table), {
            fields: `${junction.primaryKey},${junction.otherColumn}`,
            [`where[${junction.column}][_eq]`]: String(key),
            order_by: junction.primaryKey,
            limit: 500
          })
          return data.map(row => ({ id: row[junction.primaryKey], other: row[junction.otherColumn] }))
        }
      })
      record.handle.attach(links.lines)
      junctions[field.id] = links.handle
      junctionLoads.push(links.load)
      await links.load(record.handle.pk)
    }))
  }
  // Another record opened, a new one, a new one saved: its links read again.
  watch(() => record?.handle.pk, pk => junctionLoads.forEach(load => void load(pk)))

  // A Value whose default is a field of the viewer the session doesn't carry - a column the project added to
  // users (AGENTS.md section 11): read once through the Data API, under the viewer's own grants (B50).
  const userRow: Record<string, unknown> = {}
  const sessionUser = (session.admin.value as Record<string, unknown> | null) ?? {}
  const userFieldValues = definitions.flatMap(d => (d.kind === 'VALUE' && d.default?.source === 'user' && !(d.default.field in sessionUser) ? [{ name: d.name, field: d.default.field }] : []))
  async function loadUserFields() {
    const id = session.admin.value?.id
    if (!id || userFieldValues.length === 0) return
    const columns = [...new Set(userFieldValues.map(d => d.field))]
    try {
      const { data } = await dataApi.get<Record<string, unknown>>(dataApi.resourcePath('totalbase', 'users', 'table', String(id)), { fields: columns.join(',') })
      Object.assign(userRow, data)
    } catch {
      // Not readable by this viewer: the Value starts empty, as before.
      return
    }
    for (const definition of userFieldValues) (engine.vars[definition.name] as ValueHandle).reset()
  }

  const emitsByVariable = new Map(definitions.map(d => [d.name, d.emits ?? {}]))
  const engine = createVariablesEngine(definitions, {
    transport,
    record: record?.handle,
    emit(variable, event, payload) {
      const handler = emitsByVariable.get(variable)?.[event]
      return handler ? emitHandler(handler, payload) : undefined
    },
    resolveDefault(definition, source, vars) {
      if (source.source === 'param') return options.params?.[source.name] ?? null
      if (source.source === 'user') return (session.admin.value as Record<string, unknown> | null)?.[source.field] ?? userRow[source.field] ?? null
      // Evaluated as the Value's type: TODAY() for a date is the viewer's day (YYYY-MM-DD), never a UTC instant.
      return evaluateWidgetFormula(source.formula, { vars }, formulaTypeFor(definition.type))
    }
  })

  /**
   * `dataview.controls` for the Code: a named widget hidden by Visible is off the page - its control gone. Called
   * anyway, it says so in the console (Hidden, still active keeps it) instead of failing on undefined.
   */
  const codeControls = new Proxy(controls, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver)
      const placed = fields.value.some(f => f.kind === 'WIDGET' && f.label === key)
      if (!placed) return undefined
      return new Proxy({}, {
        get(_stub, member) {
          if (typeof member !== 'string' || member === 'then') return undefined
          return () => {
            console.warn(`dataview.controls.${key}.${member}(): "${key}" is hidden (Visible) - off the page, so it does nothing. Turn on its "Hidden, still active" to keep it working unseen.`)
          }
        }
      })
    }
  })

  Object.assign(context, {
    vars: engine.vars,
    controls: codeControls,
    params: options.params ?? {},
    notify,
    confirm,
    format,
    openDataView,
    openFile,
    // `dataview.device.location()` - the device's position, `{ lng, lat, accuracy }`; rejects with `reason` when there's none.
    device: { location: currentLocation }
  })

  function resourceDefinition(variable: string) {
    const definition = definitions.find(d => d.name === variable)
    return definition?.kind === 'RESOURCE' ? definition : undefined
  }

  const runtime: WidgetRuntime = {
    mode: 'live',
    fields: computed(() => fields.value.filter(f => f.kind === 'WIDGET')),
    vars: engine.vars,
    controls,
    emit: emitHandler,
    notify,
    record: record?.handle,
    junctions,
    resourceColumns: (variable) => {
      const definition = resourceDefinition(variable)
      return definition ? resources[definition.resource]?.columns : undefined
    },
    resourceFields: (variable) => {
      const definition = resourceDefinition(variable)
      return definition ? queryFields(definition.query.fields, resources[definition.resource]?.columns) : undefined
    },
    resourcePresentation: (variable) => {
      const definition = resourceDefinition(variable)
      if (!definition) return undefined
      const fields = queryFields(definition.query.fields, resources[definition.resource]?.columns)
      return withRelatedPresentation(dataview.value.columnPresentation?.[definition.resource], fields, resources[definition.resource]?.relations, dataview.value.columnPresentation)
    },
    recordPresentation: column => dataview.value.columnPresentation?.[dataview.value.sourceResource ?? '']?.[column],
    foreignKeyLabels: async (variable, rows) => {
      const definition = resourceDefinition(variable)
      const displays = definition ? resources[definition.resource]?.displays : undefined
      if (!definition || !displays) return {}
      const fields = new Set(queryFields(definition.query.fields, resources[definition.resource]?.columns))
      const entries = await Promise.all(Object.entries(displays).filter(([fk]) => fields.has(fk)).map(async ([fk, target]) => {
        const keys = [...new Set(rows.map(row => row[fk]).filter(v => v !== null && v !== undefined).map(String))]
        if (keys.length === 0) return [fk, {}] as const
        const display = foreignKeyDisplay({ config: { display_field: target.displayField, ...(target.displayTemplate && { display_template: target.displayTemplate }) } }, target.column)
        try {
          const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(target.schema, target.table), {
            fields: [...new Set([target.column, ...display.columns])].join(','),
            [`where[${target.column}][_in]`]: keys.join(','),
            limit: keys.length
          })
          return [fk, Object.fromEntries(data.map(row => [String(row[target.column]), display.text(row)]))] as const
        } catch {
          return [fk, {}] as const
        }
      }))
      return Object.fromEntries(entries)
    },
    format
  }

  // Values whose default is a formula: on a first visit its functions (formula.js) may still be loading - the
  // default would read as nothing. start() waits for them and takes those defaults again, in order.
  const formulaValues = definitions.filter(d => d.kind === 'VALUE' && d.default?.source === 'formula').map(d => d.name)

  async function start() {
    if (formulaValues.length > 0) {
      await loadFormulaFunctions()
      for (const name of formulaValues) (engine.vars[name] as ValueHandle).reset()
    }
    await loadUserFields()
    // The record first: a Resource may filter by it ({{vars.record.data.id}}).
    if (record) await record.start(options.params?.pk, options.recordView)
    await startJunctions()
    await engine.start()
    if (compiled.value.functions.onLoad) await emitHandler('onLoad', {})
  }

  onBeforeUnmount(() => engine.dispose())

  return { runtime, start, dialogs, codeError: computed(() => compiled.value.error) }
}
