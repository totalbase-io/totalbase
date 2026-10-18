<script setup lang="ts">
/**
 * The Code tab's toolbar (CustomDesigner.vue): "Page events", Insert snippet
 * and the Reference.
 *
 * "Page events" are the events of the page itself, not of one widget or
 * variable: `onLoad`, run by its name once the variables have loaded, and -
 * with a record table - the record's (load, before:save, save), bound in
 * `view_config.record.emits`. One already in the code is jumped to; one that
 * isn't is scaffolded (a snippet may write its body), bound when it's the
 * record's, and shown - the designer does that on `addOnLoad`/
 * `addRecordEvent`. A menu, not a select: it never holds a value.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import { VARIABLE_CATALOG } from '@totalbase/tb-catalog'

const props = defineProps<{
  /** The functions the Code declares - an event's handler among them shows as declared. */
  codeFunctions: string[]
  /** The page has a record table - its events are offered. */
  hasRecord: boolean
  /** `view_config.record.emits` - which function each record event is bound to. */
  recordEmits: Record<string, string> | undefined
}>()
const emit = defineEmits<{
  addOnLoad: []
  addRecordEvent: [event: string]
  insertSnippet: []
  openReference: []
}>()
const { t } = useI18n()
const cat = useDesignerCatalogText()

const ON_LOAD = 'onLoad'
const RECORD_EVENTS = Object.entries(VARIABLE_CATALOG.RECORD.emits) as [string, { label: string, payload?: string }][]
const pageEventItems = computed<DropdownMenuItem[][]>(() => {
  const inCode = (name: string | undefined) => Boolean(name && props.codeFunctions.includes(name))
  const item = (label: string, declared: boolean, onSelect: () => void) => ({
    label,
    icon: declared ? 'i-lucide-check' : 'i-lucide-plus',
    description: declared ? t('designer.customDesigner.pageEvents.declared') : t('designer.customDesigner.pageEvents.notDeclared'),
    onSelect
  })
  return [
    [
      { type: 'label' as const, label: t('designer.customDesigner.pageEvents.page') },
      item(t('designer.customDesigner.pageEvents.onLoad', { name: ON_LOAD }), inCode(ON_LOAD), () => emit('addOnLoad'))
    ],
    ...(props.hasRecord
      ? [[
          { type: 'label' as const, label: t('designer.customDesigner.pageEvents.record') },
          ...RECORD_EVENTS.map(([event, meta]) => item(`${cat.variableEmitLabel('RECORD', event, meta.label)} - ${event}`, inCode(props.recordEmits?.[event]), () => emit('addRecordEvent', event)))
        ]]
      : [])
  ]
})
</script>

<template>
  <div class="flex shrink-0 items-start justify-between gap-3">
    <p class="text-xs text-muted">
      {{ t('designer.customDesigner.codeHelp', { args: '(dataview, event)' }) }}
    </p>
    <div class="flex shrink-0 items-center gap-2">
      <UDropdownMenu
        :items="pageEventItems"
        :content="{ align: 'end' }"
      >
        <UButton
          :label="t('designer.customDesigner.pageEvents.button')"
          icon="i-lucide-zap"
          trailing-icon="i-lucide-chevron-down"
          color="neutral"
          variant="outline"
          size="sm"
        />
      </UDropdownMenu>
      <UButton
        :label="t('designer.customDesigner.insertSnippet')"
        icon="i-lucide-wand-sparkles"
        color="neutral"
        variant="outline"
        size="sm"
        @click="emit('insertSnippet')"
      />
      <UButton
        :label="t('designer.customDesigner.reference')"
        icon="i-lucide-book-open"
        color="neutral"
        variant="outline"
        size="sm"
        @click="emit('openReference')"
      />
    </div>
  </div>
</template>
