<script setup lang="ts">
/**
 * Picks a snippet and answers its questions (Specification_DataViews.md §11.2)
 * - for "Create handler" (an empty function, or a snippet as its
 * body) and for the Code's "Insert snippet" (lines at the cursor). It only
 * chooses; the host writes the code the snippet renders, where it belongs.
 */
import { renderSnippet, SNIPPET_GROUPS, SNIPPET_NAMES, snippetDefaults, snippetDefinition, validateSnippet, type SnippetName, type SnippetParams } from '@totalbase/tb-catalog'
import type { SnippetContext } from '~/components/SnippetParamsForm.vue'
import SnippetParamsForm from '~/components/SnippetParamsForm.vue'
import { useDesignerCatalogText } from '~/utils/designer-catalog-text'

const props = defineProps<{
  /** `handler`: offers an empty function too; `insert`: only snippets. */
  mode: 'handler' | 'insert'
  /** What it's for - "Runs on Click of guardar". */
  subtitle?: string
  context: SnippetContext
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ confirm: [lines: string[] | null] }>()

const isCompact = useCompactUi()
const { t } = useI18n()
const cat = useDesignerCatalogText()
/** `null` - an empty function. */
const chosen = ref<SnippetName | null>(null)
const params = ref<SnippetParams>({})
watch(open, (value) => {
  if (!value) return
  chosen.value = props.mode === 'handler' ? null : SNIPPET_NAMES[0]!
  params.value = chosen.value ? snippetDefaults(chosen.value) : {}
})
function choose(name: SnippetName | null) {
  chosen.value = name
  params.value = name ? snippetDefaults(name) : {}
}

const groups = computed(() => SNIPPET_GROUPS.map(group => ({
  ...group,
  label: cat.snippetGroupLabel(group.key, group.label),
  items: SNIPPET_NAMES.filter(n => snippetDefinition(n).group === group.key && (snippetDefinition(n).requires !== 'record' || props.context.hasRecord))
})).filter(group => group.items.length > 0))
const errors = computed(() => (chosen.value ? validateSnippet(chosen.value, params.value) : []))
const preview = computed(() => (chosen.value && errors.value.length === 0 ? renderSnippet(chosen.value, params.value).join('\n') : ''))

function confirm() {
  if (errors.value.length) return
  emit('confirm', chosen.value ? renderSnippet(chosen.value, params.value) : null)
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="mode === 'handler' ? t('designer.inspector.createHandler') : t('designer.snippetModal.insertSnippet')"
    :description="subtitle ?? t('designer.snippetModal.description')"
    :fullscreen="isCompact"
    :ui="{ content: 'max-w-4xl' }"
  >
    <template #body>
      <div class="flex min-h-96 gap-4 max-md:flex-col">
        <div class="flex w-64 shrink-0 flex-col gap-3 max-md:w-full">
          <button
            v-if="mode === 'handler'"
            type="button"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
            :class="chosen === null ? 'bg-elevated text-highlighted' : 'hover:bg-elevated/50'"
            @click="choose(null)"
          >
            <UIcon
              name="i-lucide-braces"
              class="size-4 shrink-0 text-muted"
            />
            {{ t('designer.snippetModal.emptyFunction') }}
          </button>
          <div
            v-for="group in groups"
            :key="group.key"
            class="flex flex-col gap-1"
          >
            <p class="text-xs font-semibold uppercase tracking-wide text-muted">
              {{ group.label }}
            </p>
            <button
              v-for="name in group.items"
              :key="name"
              type="button"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              :class="chosen === name ? 'bg-elevated text-highlighted' : 'hover:bg-elevated/50'"
              @click="choose(name)"
            >
              <UIcon
                :name="snippetDefinition(name).icon"
                class="size-4 shrink-0 text-muted"
              />
              <span class="truncate">{{ cat.snippetLabel(name, snippetDefinition(name).label) }}</span>
            </button>
          </div>
        </div>

        <div class="flex min-w-0 flex-1 flex-col gap-4">
          <p
            v-if="chosen === null"
            class="text-sm text-muted"
          >
            {{ t('designer.snippetModal.emptyFunctionDescription') }}
          </p>
          <template v-else>
            <p class="text-sm text-muted">
              {{ cat.snippetDescription(chosen, snippetDefinition(chosen).description) }}
            </p>
            <SnippetParamsForm
              :key="chosen"
              v-model="params"
              :name="chosen"
              :context="context"
            />
            <div
              v-if="preview"
              class="flex flex-col gap-1"
            >
              <p class="text-xs font-medium text-muted">
                {{ t('designer.snippetModal.theCode') }}
              </p>
              <pre class="overflow-x-auto rounded-md bg-elevated p-3 font-mono text-xs">{{ preview }}</pre>
            </div>
          </template>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="mode === 'handler' ? t('common.create') : t('designer.snippetModal.insert')"
          :disabled="errors.length > 0"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
