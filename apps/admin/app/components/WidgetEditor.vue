<script setup lang="ts">
/**
 * `UEditor` adapter - unlike `TJson`/`TColorSelect`/etc, this ISN'T a
 * fictional name standing in for a component that doesn't exist: Nuxt UI
 * ships a real `UEditor` (Tiptap-based, `@tiptap/*` already a dependency
 * here). This wrapper exists only to resolve which of its three
 * `contentType`s to use from the field's own config
 * (`FieldConfig.editorContentType` - Design form's own "Content type"
 * control), since `WidgetRenderer.vue`'s generic `widgetProps()`
 * already threads that through as a plain `content-type` prop - this
 * component is the seam so a future editor-specific need (a fixed
 * toolbar, image/mention config) has somewhere to live without touching
 * the generic cell renderer again.
 *
 * `UEditorToolbar` renders nothing without `items` - the toolbar was
 * silently empty until they were passed. Only formatting every content
 * type can store is offered: no underline/alignment, which markdown has
 * no syntax for (they'd be dropped on save).
 */
import type { EditorProps } from '@nuxt/ui'

defineOptions({ inheritAttrs: false })
const modelValue = defineModel<EditorProps['modelValue']>()
const props = withDefaults(defineProps<{
  contentType?: 'markdown' | 'html' | 'json'
  disabled?: boolean
  /** Stretch to the parent's full height (e.g. the dashboard Note drawer) instead of the default min/max content height. */
  fill?: boolean
}>(), {
  contentType: 'markdown',
  disabled: false,
  fill: false
})
const attrs = useAttrs()

const items = [
  [
    { kind: 'undo' as const, icon: 'i-lucide-undo-2' },
    { kind: 'redo' as const, icon: 'i-lucide-redo-2' }
  ],
  [
    { kind: 'heading' as const, level: 1 as const, icon: 'i-lucide-heading-1' },
    { kind: 'heading' as const, level: 2 as const, icon: 'i-lucide-heading-2' },
    { kind: 'heading' as const, level: 3 as const, icon: 'i-lucide-heading-3' },
    { kind: 'paragraph' as const, icon: 'i-lucide-pilcrow' }
  ],
  [
    { kind: 'mark' as const, mark: 'bold' as const, icon: 'i-lucide-bold' },
    { kind: 'mark' as const, mark: 'italic' as const, icon: 'i-lucide-italic' },
    { kind: 'mark' as const, mark: 'strike' as const, icon: 'i-lucide-strikethrough' },
    { kind: 'mark' as const, mark: 'code' as const, icon: 'i-lucide-code' }
  ],
  [
    { kind: 'bulletList' as const, icon: 'i-lucide-list' },
    { kind: 'orderedList' as const, icon: 'i-lucide-list-ordered' },
    { kind: 'blockquote' as const, icon: 'i-lucide-quote' },
    { kind: 'codeBlock' as const, icon: 'i-lucide-square-code' },
    { kind: 'horizontalRule' as const, icon: 'i-lucide-minus' }
  ],
  [
    { kind: 'link' as const, icon: 'i-lucide-link' }
  ]
]
</script>

<template>
  <div
    v-bind="attrs"
    :class="fill ? 'flex min-h-0 flex-col' : ''"
  >
    <UEditor
      v-model="modelValue"
      :content-type="props.contentType"
      :editable="!props.disabled"
      class="w-full rounded-md border border-default"
      :class="fill ? 'flex min-h-0 flex-1 flex-col' : ''"
      :ui="{
        root: fill ? 'flex min-h-0 flex-1 flex-col' : '',
        content: fill ? 'min-h-0 flex-1 overflow-y-auto p-3' : 'min-h-32 p-2'
      }"
    >
      <template #default="{ editor }">
        <UEditorToolbar
          v-if="!props.disabled"
          :editor="editor"
          :items="items"
          class="flex-wrap border-b border-default bg-elevated/50"
        />
      </template>
    </UEditor>
  </div>
</template>
