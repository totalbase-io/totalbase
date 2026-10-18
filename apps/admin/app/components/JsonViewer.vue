<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { defineAdminThemes } from '~/utils/monaco-theme'

// Read-only JSON viewer (openapi.vue's spec dump) - a trimmed-down
// sibling of SqlEditor.vue: no execute action, no formatter, editing
// disabled, but the same shared admin theme/Monaco loading approach so
// it reads as the same "editor" visual language as SQL Console.
const props = defineProps<{
  modelValue: string
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null

const colorMode = useColorMode()
const wordWrap = ref(false)

function toggleWordWrap() {
  wordWrap.value = !wordWrap.value
  editor?.updateOptions({ wordWrap: wordWrap.value ? 'on' : 'off' })
}

// Delegates to Monaco's own find widget rather than a bespoke filter -
// it already highlights matches, supports regex/case toggles, and jumps
// the viewport, which a plain text filter over the JSON string wouldn't.
function find() {
  editor?.focus()
  editor?.trigger('toolbar', 'actions.find', null)
}

// Scrolls the first occurrence of `text` to the top and selects it - how
// the Endpoints list's "Open in API docs" lands on one path. Held until
// Monaco has loaded when called before that.
let pendingReveal: string | null = null
function reveal(text: string) {
  if (!editor || !monaco) {
    pendingReveal = text
    return
  }
  const match = editor.getModel()?.findMatches(text, false, false, true, null, false, 1)[0]
  if (!match) return
  editor.setSelection(match.range)
  editor.revealRangeAtTop(match.range)
}

defineExpose({ wordWrap, toggleWordWrap, find, reveal })

onMounted(async () => {
  // Loaded dynamically so Monaco (a few MB) is only fetched when this
  // viewer is actually mounted - same rationale as SqlEditor.vue.
  monaco = await import('monaco-editor')
  if (!containerRef.value) return
  defineAdminThemes(monaco)

  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: 'json',
    theme: colorMode.value === 'dark' ? 'totalbase-dark' : 'totalbase-light',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    readOnly: true,
    domReadOnly: true
  })
  if (pendingReveal) reveal(pendingReveal)
  pendingReveal = null
})

watch(() => colorMode.value, (mode) => {
  monaco?.editor.setTheme(mode === 'dark' ? 'totalbase-dark' : 'totalbase-light')
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
    class="w-full h-full min-h-64"
  />
</template>
