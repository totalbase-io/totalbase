<script setup lang="ts">
/**
 * WidgetInspector.vue's `function` editor - a prop that names a Code function
 * (a form's Validate): one of the Code's functions, or "Create" to have the
 * host scaffold one; a set one opens in the Code.
 */
import type { WidgetProp } from '@totalbase/tb-catalog'

const props = defineProps<{
  prop: WidgetProp
  value: string | undefined
  /** The Code's function names. */
  codeFunctions?: readonly string[]
}>()
const emit = defineEmits<{
  /** The prop's new value - `undefined` clears it. */
  set: [value: string | undefined]
  createFunction: []
  openHandler: [name: string]
}>()
const { t } = useI18n()
/** Reka's select can't hold an empty value. */
const NONE = '__none__'
const functionItems = computed(() => [
  { label: t('common.none'), value: NONE },
  ...(props.codeFunctions ?? []).map(name => ({ label: name, value: name }))
])
</script>

<template>
  <UFormField
    :label="prop.label"
    :description="prop.description"
  >
    <div class="flex gap-1">
      <USelect
        :model-value="value ?? NONE"
        :items="functionItems"
        class="min-w-0 flex-1"
        @update:model-value="emit('set', $event === NONE ? undefined : $event)"
      />
      <UTooltip
        v-if="!value"
        :text="t('designer.inspector.createFunction')"
      >
        <UButton
          icon="i-lucide-square-plus"
          color="neutral"
          variant="outline"
          :aria-label="t('designer.inspector.createFunction')"
          @click="emit('createFunction')"
        />
      </UTooltip>
      <UTooltip
        v-else
        :text="t('designer.inspector.openInCode')"
      >
        <UButton
          icon="i-lucide-code"
          color="neutral"
          variant="outline"
          :aria-label="t('designer.inspector.openInCode')"
          @click="emit('openHandler', value!)"
        />
      </UTooltip>
    </div>
  </UFormField>
</template>
