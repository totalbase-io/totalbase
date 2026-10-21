<script setup lang="ts">
/**
 * WidgetInspector.vue's text of a form field bound to a column (label,
 * description, hint, help - DataViews.md §15): inherited from
 * the column's presentation, its own, or none ("": shown nowhere, the column
 * untouched). The inspector keeps the three-state logic; this draws the
 * field, its None toggle and the line saying which state it's in.
 */
import type { WidgetProp } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'

defineProps<{
  name: string
  prop: WidgetProp
  value: string | undefined
  state: 'inherited' | 'own' | 'none'
  /** What the column gives the field - a label falls back to the name humanized; a hint, nothing. */
  inheritedText: string
  /** Its own text, the same as the column's - nothing of its own to keep (T78). */
  sameAsColumn: boolean
  /** The Bind modal's kind - rich text only where the prop renders text. */
  bindKind: 'text' | 'boolean' | 'value'
  formula: string
  columns?: CatalogColumn[]
  relations?: RelationDefinition[]
  /** The column's presentation can be edited over the page (the record's resource is known). */
  canEditColumn: boolean
  /** Else, where it's edited (Database) - a full href, opened in a new tab. */
  presentationLink?: string
}>()
const emit = defineEmits<{
  /** The text typed - the inspector's setProp (an emptied field goes back to inherited). */
  set: [value: unknown]
  /** None stores "" - the inspector's own toggle, past setProp. */
  toggleNone: []
  setFormula: [formula: string]
  editColumn: []
}>()
const { t } = useI18n()
</script>

<template>
  <UFormField
    :label="prop.label"
    :description="state === 'inherited' && inheritedText ? t('designer.inspector.inheritedValue', { value: inheritedText }) : prop.description"
  >
    <div class="flex items-center gap-1">
      <UInput
        :model-value="value ?? ''"
        :disabled="state === 'none'"
        :aria-label="prop.label"
        class="min-w-0 flex-1"
        @update:model-value="emit('set', $event)"
      />
      <UTooltip :text="state === 'none' ? t('designer.inspector.inheritedUse') : t('designer.inspector.inheritedNone', { label: prop.label })">
        <UButton
          :icon="state === 'none' ? 'i-lucide-undo-2' : 'i-lucide-ban'"
          color="neutral"
          :variant="state === 'none' ? 'soft' : 'ghost'"
          :aria-label="state === 'none' ? t('designer.inspector.inheritedUse') : t('designer.inspector.inheritedNone', { label: prop.label })"
          :aria-pressed="state === 'none'"
          @click="emit('toggleNone')"
        />
      </UTooltip>
      <BindingButton
        v-if="prop.binding === 'formula'"
        :model-value="formula"
        :kind="bindKind"
        :label="prop.label"
        :columns="columns"
        :relations="relations"
        beside-input
        @update:model-value="emit('setFormula', $event)"
      />
    </div>
    <!-- A hint is never inherited: no line while it has none of its own. -->
    <p
      v-if="name !== 'hint' || state !== 'inherited'"
      class="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted"
    >
      <template v-if="state === 'none'">
        {{ t('designer.inspector.inheritedStateNone') }}
      </template>
      <template v-else-if="state === 'own'">
        <span :class="sameAsColumn ? 'text-warning' : ''">{{ sameAsColumn ? t('designer.inspector.inheritedStateSame') : t('designer.inspector.inheritedStateOwn') }}</span> ·
        <UButton
          :label="t('designer.inspector.inheritedUse')"
          variant="link"
          size="xs"
          class="p-0"
          @click="emit('set', undefined)"
        />
      </template>
      <template v-else>
        {{ inheritedText ? t('designer.inspector.inheritedStateInherited') : t('designer.inspector.inheritedStateEmpty') }}
        <template v-if="canEditColumn && name !== 'hint'">
          ·
          <UButton
            :label="t('designer.inspector.inheritedEdit')"
            variant="link"
            size="xs"
            class="p-0"
            @click="emit('editColumn')"
          />
        </template>
        <template v-else-if="presentationLink && name !== 'hint'">
          ·
          <a
            :href="presentationLink"
            target="_blank"
            rel="noopener"
            class="text-primary hover:underline"
          >{{ t('designer.inspector.inheritedEdit') }}</a>
        </template>
      </template>
    </p>
  </UFormField>
</template>
