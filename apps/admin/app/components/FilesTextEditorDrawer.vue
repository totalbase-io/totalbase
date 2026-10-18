<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { adminThemeName, defineAdminThemes } from '~/utils/monaco-theme'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  modelValue: string
  language?: string
  loading?: boolean
  saving?: boolean
}>(), {
  language: 'plaintext',
  loading: false,
  saving: false
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:modelValue': [value: string]
  'save': []
}>()

const { t } = useI18n()
const containerRef = ref<HTMLDivElement | null>(null)
let editor: Monaco.editor.IStandaloneCodeEditor | null = null
let monaco: typeof Monaco | null = null

const colorMode = useColorMode()
const wordWrap = ref(true)
const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value)
})

function layoutEditor() {
  requestAnimationFrame(() => editor?.layout())
}

function disposeEditor() {
  editor?.dispose()
  editor = null
}

function syncEditorValue(value: string) {
  if (!editor || editor.getValue() === value) return
  editor.setValue(value)
  editor.setPosition({ lineNumber: 1, column: 1 })
  editor.setScrollTop(0)
  editor.setScrollLeft(0)
}

function currentSelectionOrAll(): string {
  if (!editor) return props.modelValue
  const selection = editor.getSelection()
  if (selection && !selection.isEmpty()) {
    return editor.getModel()?.getValueInRange(selection) ?? ''
  }
  return editor.getValue()
}

function undo() {
  editor?.trigger('toolbar', 'undo', null)
  editor?.focus()
}

function redo() {
  editor?.trigger('toolbar', 'redo', null)
  editor?.focus()
}

async function copySelection() {
  const text = currentSelectionOrAll()
  if (text) await navigator.clipboard.writeText(text)
  editor?.focus()
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

function toggleWordWrap() {
  wordWrap.value = !wordWrap.value
  editor?.updateOptions({ wordWrap: wordWrap.value ? 'on' : 'off' })
  editor?.focus()
}

async function mountEditor() {
  if (editor || !containerRef.value) return
  monaco = await import('monaco-editor')
  if (!containerRef.value) return
  defineAdminThemes(monaco)
  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: props.language,
    theme: adminThemeName(colorMode.value === 'dark' ? 'dark' : 'light'),
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    wordWrap: wordWrap.value ? 'on' : 'off'
  })
  editor.onDidChangeModelContent(() => {
    emit('update:modelValue', editor!.getValue())
  })
  layoutEditor()
  editor.focus()
}

watch(() => props.open, async (open) => {
  if (!open) {
    disposeEditor()
    return
  }
  await nextTick(mountEditor)
  layoutEditor()
})

watch(() => props.loading, async (loading) => {
  if (loading || !props.open) return
  await nextTick()
  syncEditorValue(props.modelValue)
  layoutEditor()
  editor?.focus()
})

watch(() => colorMode.value, (mode) => {
  monaco?.editor.setTheme(adminThemeName(mode === 'dark' ? 'dark' : 'light'))
})

watch(() => props.modelValue, (value) => {
  syncEditorValue(value)
})

watch(() => props.language, (language) => {
  const model = editor?.getModel()
  if (model && monaco) monaco.editor.setModelLanguage(model, language)
})

onBeforeUnmount(() => {
  disposeEditor()
})
</script>

<template>
  <AppDrawer
    v-model:open="openModel"
    :title="title"
    size="xl"
    start-expanded
  >
    <template #toolbar>
      <div class="flex h-9 items-center gap-1">
        <UTooltip :text="t('content.files.textEditor.undo')">
          <UButton
            :aria-label="t('content.files.textEditor.undo')"
            icon="i-lucide-undo-2"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            @click="undo"
          />
        </UTooltip>
        <UTooltip :text="t('content.files.textEditor.redo')">
          <UButton
            :aria-label="t('content.files.textEditor.redo')"
            icon="i-lucide-redo-2"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            @click="redo"
          />
        </UTooltip>
        <USeparator
          orientation="vertical"
          class="mx-1 h-5"
        />
        <UTooltip :text="t('common.copy')">
          <UButton
            :aria-label="t('common.copy')"
            icon="i-lucide-copy"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            @click="copySelection"
          />
        </UTooltip>
        <UTooltip :text="t('content.files.textEditor.paste')">
          <UButton
            :aria-label="t('content.files.textEditor.paste')"
            icon="i-lucide-clipboard-paste"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            @click="pasteAtCursor"
          />
        </UTooltip>
        <USeparator
          orientation="vertical"
          class="mx-1 h-5"
        />
        <UTooltip :text="t('content.files.textEditor.wordWrap')">
          <UButton
            :aria-label="t('content.files.textEditor.wordWrap')"
            icon="i-lucide-wrap-text"
            color="neutral"
            :variant="wordWrap ? 'soft' : 'ghost'"
            size="sm"
            square
            @click="toggleWordWrap"
          />
        </UTooltip>

        <div class="ml-auto">
          <UButton
            :label="t('common.save')"
            icon="i-lucide-save"
            size="sm"
            :loading="saving"
            @click="emit('save')"
          />
        </div>
      </div>
    </template>

    <div class="relative min-h-0 flex-1 overflow-hidden border border-default">
      <div
        ref="containerRef"
        class="h-full w-full"
      />
      <div
        v-if="loading"
        class="absolute inset-0 flex items-center justify-center gap-2 bg-default/80 text-sm text-muted backdrop-blur-[1px]"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
        {{ t('content.files.textEditor.loading') }}
      </div>
    </div>
  </AppDrawer>
</template>
