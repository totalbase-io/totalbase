<script setup lang="ts">
/**
 * WidgetInspector.vue's Events tab: the component's own emits, each calling a
 * Code function - one of the Code's, or "Create handler" to have the host
 * scaffold one; a set one opens in the Code.
 */
const props = defineProps<{
  /** The widget's emits, each with its label in the UI's language. */
  entries: readonly (readonly [string, { label: string, payload?: string }])[]
  /** The handlers set - `config.emits`. */
  handlers: Record<string, string>
  /** The Code's function names. */
  codeFunctions?: readonly string[]
}>()
const emit = defineEmits<{
  /** An event's handler - `undefined` clears it. */
  setHandler: [event: string, handler: string | undefined]
  createHandler: [event: string]
  openHandler: [name: string]
}>()
const { t } = useI18n()
/** Reka's select can't hold an empty value. */
const NONE = '__none__'
const functionItems = computed(() => [
  { label: t('common.none'), value: NONE },
  ...(props.codeFunctions ?? []).map(name => ({ label: name, value: name }))
])
function handlerOf(event: string): string {
  return props.handlers[event] ?? NONE
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UFormField
      v-for="[name, emitEntry] in entries"
      :key="name"
      :label="emitEntry.label"
      :description="emitEntry.payload ? t('designer.inspector.receivesEvent', { payload: emitEntry.payload }) : t('designer.inspector.receives', { signature: '(dataview)' })"
    >
      <div class="flex gap-1">
        <USelect
          :model-value="handlerOf(name)"
          :items="functionItems"
          class="flex-1 min-w-0"
          @update:model-value="emit('setHandler', name, $event === NONE ? undefined : $event)"
        />
        <UTooltip
          v-if="handlerOf(name) === NONE"
          :text="t('designer.inspector.createHandler')"
        >
          <UButton
            icon="i-lucide-square-plus"
            color="neutral"
            variant="outline"
            :aria-label="t('designer.inspector.createHandler')"
            @click="emit('createHandler', name)"
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
            @click="emit('openHandler', handlerOf(name))"
          />
        </UTooltip>
      </div>
    </UFormField>
    <UEmpty
      v-if="entries.length === 0"
      icon="i-lucide-zap-off"
      :title="t('designer.inspector.noEvents')"
      variant="naked"
      size="sm"
    />
  </div>
</template>
