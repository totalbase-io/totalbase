<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { adminThemeName, defineAdminThemes } from '~/utils/monaco-theme'

// Small editable JSON editor - a trimmed-down sibling of SqlEditor.vue/
// JsonViewer.vue (same shared theme/lazy-load approach) for a single
// field's worth of JSON, not a full-page tool: no toolbar, just syntax
// highlighting and bracket matching for something like a permission's
// row-filter object. See roles/[id].vue's editor slideover.
const props = withDefaults(defineProps<{
  modelValue: string
  minHeight?: string
  /** Read-only pass-through (Monaco's own `readOnly`/`domReadOnly`) - added for WidgetJsonEditor.vue's own `disabled`/readonly field config, which every OTHER widget already respects; WhereField's own Builder popover (this editor's original caller) never sets it, so it stays false there unchanged. */
  disabled?: boolean
}>(), {
  minHeight: '8rem',
  disabled: false
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null

const colorMode = useColorMode()

// Same shape as SqlEditor.vue's formatSql: re-serialize with 2-space
// indent via a single editor edit (undo-able as one step), leaving the
// buffer untouched if it isn't valid JSON yet (mid-edit, a typo) rather
// than surfacing a formatter-specific error for that.
function format() {
  if (!editor) return
  try {
    const formatted = JSON.stringify(JSON.parse(editor.getValue()), null, 2)
    editor.executeEdits('format', [{ range: editor.getModel()!.getFullModelRange(), text: formatted }])
  } catch {
    // Not valid JSON yet - leave the buffer untouched.
  }
}

defineExpose({ format })

onMounted(async () => {
  // Loaded dynamically so Monaco (a few MB) is only fetched once this
  // editor actually mounts, same rationale as SqlEditor.vue/JsonViewer.vue -
  // the admin already pays this cost elsewhere, so reusing it here is
  // marginal, not a new heavy dependency.
  monaco = await import('monaco-editor')
  if (!containerRef.value) return
  defineAdminThemes(monaco)

  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: 'json',
    theme: adminThemeName(colorMode.value === 'dark' ? 'dark' : 'light'),
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 0,
    readOnly: props.disabled,
    domReadOnly: props.disabled
  })

  editor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor!.getValue())
  })
})

watch(() => colorMode.value, (mode) => {
  monaco?.editor.setTheme(adminThemeName(mode === 'dark' ? 'dark' : 'light'))
})

watch(() => props.disabled, (disabled) => {
  editor?.updateOptions({ readOnly: disabled, domReadOnly: disabled })
})

watch(() => props.modelValue, (value) => {
  if (editor && editor.getValue() !== value) editor.setValue(value)
})

onBeforeUnmount(() => {
  editor?.dispose()
})
</script>

<template>
  <div
    ref="containerRef"
    class="w-full border border-default rounded-md overflow-hidden"
    :style="{ height: minHeight }"
  />
</template>
