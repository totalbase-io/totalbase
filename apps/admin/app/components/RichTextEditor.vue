<script setup lang="ts">
import TextAlign from '@tiptap/extension-text-align'

// WYSIWYG for a mailing template's/mailing's HTML body (subject stays
// plain text with {{variable}} placeholders - see NameSlugFields/subject field in
// templates.vue) and for the Send-email workflow step's HTML body. Wraps
// Nuxt UI's own `UEditor`/`UEditorToolbar` (Tiptap-based, `@tiptap/*`
// already a dependency of `@nuxt/ui` itself) instead of hand-rolling a
// second Tiptap instance - the only extra extension pulled in here is
// TextAlign, which `UEditor` doesn't wire up by default; everything else
// (bold/italic/underline/strike, headings, lists, blockquote, hr,
// link/image, undo-redo) comes from `UEditor`'s own StarterKit config via
// its built-in toolbar item `kind`s. Emits plain HTML, same shape
// mailings.content_type already supports ('text/html'). No merge-tag/
// variable picker yet - {{variable}} placeholders typed directly still
// render correctly since they are substituted on the raw HTML string
// regardless of surrounding markup.
const model = defineModel<string>({ required: true })

// `fill` - stretch to the parent's full height (mailings.vue's compose
// drawer, where the message area is the flex-1 remainder of the drawer)
// instead of the default fixed min/max height (templates.vue's modal and
// the Send-email workflow modal, neither of which have a bounded height
// to fill).
const { fill = false } = defineProps<{ fill?: boolean }>()

// Raw HTML view - not one of UEditor's built-in toolbar `kind`s, so it's
// a plain custom item (EditorToolbar supports arbitrary non-`kind`
// buttons) that flips the body between EditorContent and a UTextarea
// bound to the same `model`.
const showSource = ref(false)
const { t } = useI18n()

const items = computed(() => [
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
    { kind: 'mark' as const, mark: 'underline' as const, icon: 'i-lucide-underline' },
    { kind: 'mark' as const, mark: 'strike' as const, icon: 'i-lucide-strikethrough' }
  ],
  [
    { kind: 'bulletList' as const, icon: 'i-lucide-list' },
    { kind: 'orderedList' as const, icon: 'i-lucide-list-ordered' },
    { kind: 'blockquote' as const, icon: 'i-lucide-quote' },
    { kind: 'horizontalRule' as const, icon: 'i-lucide-minus' }
  ],
  [
    { kind: 'textAlign' as const, align: 'left' as const, icon: 'i-lucide-align-left' },
    { kind: 'textAlign' as const, align: 'center' as const, icon: 'i-lucide-align-center' },
    { kind: 'textAlign' as const, align: 'right' as const, icon: 'i-lucide-align-right' },
    { kind: 'textAlign' as const, align: 'justify' as const, icon: 'i-lucide-align-justify' }
  ],
  [
    { kind: 'link' as const, icon: 'i-lucide-link' },
    { kind: 'image' as const, icon: 'i-lucide-image' }
  ],
  [
    { icon: 'i-lucide-code', active: showSource.value, onClick: () => { showSource.value = !showSource.value } }
  ]
])
</script>

<template>
  <div
    class="border border-default rounded-lg overflow-hidden bg-default"
    :class="fill ? 'h-full flex flex-col' : ''"
  >
    <UEditor
      v-if="!showSource"
      v-model="model"
      content-type="html"
      :mention="false"
      :extensions="[TextAlign.configure({ types: ['heading', 'paragraph'] })]"
      :class="fill ? 'flex-1 min-h-0 flex flex-col' : ''"
      :ui="{ root: fill ? 'flex-1 min-h-0 flex flex-col' : '', content: fill ? 'flex-1 min-h-0 overflow-y-auto px-3 py-2 text-sm' : 'min-h-32 max-h-96 overflow-y-auto px-3 py-2 text-sm' }"
    >
      <template #default="{ editor }">
        <UEditorToolbar
          :editor="editor"
          :items="items"
          class="flex-wrap border-b border-default bg-elevated/50"
        />
      </template>
    </UEditor>
    <template v-else>
      <!-- UEditorToolbar lives inside UEditor, which isn't rendered in
      source mode - so the same toggle gets its own bar here, in the same
      spot, or there's no way back to the visual editor. -->
      <div class="flex items-center gap-2 border-b border-default bg-elevated/50 p-1">
        <UTooltip :text="t('designer.richTextEditor.backToVisual')">
          <UButton
            icon="i-lucide-code"
            color="primary"
            variant="soft"
            size="sm"
            square
            :aria-label="t('designer.richTextEditor.backToVisual')"
            @click="showSource = false"
          />
        </UTooltip>
        <span class="text-xs text-muted">{{ t('designer.richTextEditor.htmlSource') }}</span>
      </div>
      <UTextarea
        v-model="model"
        :aria-label="t('designer.richTextEditor.htmlSource')"
        class="w-full font-mono text-xs"
        :class="fill ? 'flex-1 min-h-0' : ''"
        :ui="{ base: fill ? 'h-full' : '' }"
        :rows="fill ? undefined : 10"
      />
    </template>
  </div>
</template>
