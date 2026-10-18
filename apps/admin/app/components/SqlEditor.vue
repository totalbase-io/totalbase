<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { defineAdminThemes } from '~/utils/monaco-theme'
import { sqlErrorLocation } from '~/utils/sql-error-position'

const props = defineProps<{
  modelValue: string
  completionItems?: { label: string, insertText?: string, kind: 'table' | 'view' | 'function' | 'field' }[]
  /** Word wrap on from the start (still toggled with `toggleWordWrap`). */
  initialWordWrap?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** `start`: the editor offset where `sql` begins (a selection), for markError(). */
  'execute': [sql: string, start: number]
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null
let completionDisposable: Monaco.IDisposable | null = null

const colorMode = useColorMode()
const { t } = useI18n()

function currentSelectionOrAll(): string {
  return selectionOrAll().text
}

/** The selection (or everything) and the editor offset it starts at. */
function selectionOrAll(): { text: string, start: number } {
  if (!editor) return { text: props.modelValue, start: 0 }
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (model && selection && !selection.isEmpty()) {
    return { text: model.getValueInRange(selection), start: model.getOffsetAt(selection.getStartPosition()) }
  }
  return { text: editor.getValue(), start: 0 }
}

const ERROR_MARKER_OWNER = 'totalbase-sql-error'

/**
 * Marks a PostgreSQL error in the editor: `position` is PostgreSQL's 1-based
 * character offset into the SQL that ran, `start` the editor offset that SQL
 * began at. The word there is underlined (a single character when there is
 * none) and scrolled into view; the marker's hover shows `message`. Returns
 * the 1-based line/column, or null when the position isn't in the editor.
 * The next edit clears it.
 */
function markError(position: number, start: number, message: string): { line: number, column: number } | null {
  const model = editor?.getModel()
  if (!editor || !monaco || !model) return null
  const location = sqlErrorLocation(model.getValue(), position, start)
  if (!location) return null
  const at = { lineNumber: location.line, column: location.column }
  const word = model.getWordAtPosition(at)
  const endColumn = word && word.startColumn === location.column ? word.endColumn : location.column + 1
  monaco.editor.setModelMarkers(model, ERROR_MARKER_OWNER, [{
    severity: monaco.MarkerSeverity.Error,
    message,
    startLineNumber: location.line,
    startColumn: location.column,
    endLineNumber: location.line,
    endColumn
  }])
  editor.revealPositionInCenterIfOutsideViewport(at)
  return { line: location.line, column: location.column }
}

function clearErrorMarker() {
  const model = editor?.getModel()
  if (monaco && model) monaco.editor.setModelMarkers(model, ERROR_MARKER_OWNER, [])
}

const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24
const fontSize = ref(13)

function setFontSize(size: number) {
  fontSize.value = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size))
  editor?.updateOptions({ fontSize: fontSize.value })
}

// Native clipboard instead of Monaco's built-in clipboardCopy/PasteAction -
// those go through the browser's clipboard permission dance too but in a
// less predictable way per-browser; navigator.clipboard is the same API a
// toolbar button click already has user-activation for.
async function copySelection() {
  const text = currentSelectionOrAll()
  if (text) await navigator.clipboard.writeText(text)
}

async function pasteAtCursor() {
  const text = await navigator.clipboard.readText()
  if (!editor || !text) return
  const selection = editor.getSelection()
  editor.executeEdits('paste', [{
    range: selection ?? editor.getModel()!.getFullModelRange(),
    text,
    forceMoveMarkers: true
  }])
  editor.focus()
}

/** Inserts `text` at the cursor (replacing a selection) as one undoable edit - the widget drawer's "Optional filter". */
function insertAtCursor(text: string) {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  const selection = editor.getSelection()
  const end = { lineNumber: model.getLineCount(), column: model.getLineMaxColumn(model.getLineCount()) }
  const range = selection ?? { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }
  editor.executeEdits('insert-optional-filter', [{ range, text, forceMoveMarkers: true }])
  editor.pushUndoStop()
  editor.focus()
}

const wordWrap = ref(props.initialWordWrap ?? false)

function toggleWordWrap() {
  wordWrap.value = !wordWrap.value
  editor?.updateOptions({ wordWrap: wordWrap.value ? 'on' : 'off' })
}

// sql-formatter (~260 KB) loads on the first Format, not with every SQL editor.
async function formatSql() {
  if (!editor) return
  const { format: formatSqlText } = await import('sql-formatter')
  try {
    const formatted = formatSqlText(editor.getValue(), { language: 'postgresql' })
    editor.executeEdits('format', [{ range: editor.getModel()!.getFullModelRange(), text: formatted }])
  } catch {
    // Not valid/parseable SQL yet (mid-edit, typo, etc.) - leave the buffer
    // untouched rather than surface a formatter-specific error for what's
    // ultimately just an editing-in-progress state.
  }
}

function clear() {
  editor?.setValue('')
  editor?.focus()
}

function undo() {
  editor?.trigger('toolbar', 'undo', null)
}

function redo() {
  editor?.trigger('toolbar', 'redo', null)
}

function focus() {
  editor?.focus()
}

defineExpose({
  currentSelectionOrAll,
  selectionOrAll,
  markError,
  clearErrorMarker,
  fontSize,
  setFontSize,
  copySelection,
  pasteAtCursor,
  insertAtCursor,
  wordWrap,
  toggleWordWrap,
  formatSql,
  clear,
  undo,
  redo,
  focus
})

onMounted(async () => {
  // Loaded dynamically so Monaco (a few MB) is only fetched when the SQL
  // Console page is actually visited, not part of the main bundle.
  monaco = await import('monaco-editor')
  if (!containerRef.value) return
  defineAdminThemes(monaco)

  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: 'sql',
    theme: colorMode.value === 'dark' ? 'totalbase-dark' : 'totalbase-light',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: fontSize.value,
    wordWrap: wordWrap.value ? 'on' : 'off',
    scrollBeyondLastLine: false
  })

  editor.onDidChangeModelContent(() => {
    clearErrorMarker()
    emit('update:modelValue', editor!.getValue())
  })
  editor.addAction({
    id: 'totalbase-execute',
    label: t('database.sqlEditor.execute'),
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => {
      const { text, start } = selectionOrAll()
      emit('execute', text, start)
    }
  })

  completionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position)
      const range = new monaco!.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column)
      return { suggestions: (props.completionItems ?? []).map(item => ({
        label: item.label,
        insertText: item.insertText ?? item.label,
        range,
        kind: monaco!.languages.CompletionItemKind[
          item.kind === 'table' ? 'Class' : item.kind === 'view' ? 'Interface' : item.kind === 'function' ? 'Function' : 'Field'
        ]
      })) }
    }
  })
})

watch(() => colorMode.value, (mode) => {
  monaco?.editor.setTheme(mode === 'dark' ? 'totalbase-dark' : 'totalbase-light')
})

watch(() => props.modelValue, (value) => {
  if (editor && editor.getValue() !== value) editor.setValue(value)
})

watch(() => props.completionItems, () => {
  // Monaco asks the provider for the current list on every invocation, so
  // newly loaded catalog entries are picked up without recreating the editor.
}, { deep: true })

onBeforeUnmount(() => {
  completionDisposable?.dispose()
  editor?.dispose()
})
</script>

<template>
  <div
    ref="containerRef"
    class="w-full h-full min-h-64"
  />
</template>
