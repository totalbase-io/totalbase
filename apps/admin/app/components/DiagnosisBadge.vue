<script setup lang="ts">
/**
 * A DataView's or a dashboard's header: how many warnings stop it from working for someone (useDiagnosis.ts), a
 * popover listing them with their fixes. Nothing while there are none; read again each time it opens.
 */
const props = defineProps<{
  kind: 'dataview' | 'dashboard'
  objectId: string
}>()
const { t } = useI18n()
const { issues, warnings, refresh } = useDiagnosis(() => props.kind, () => props.objectId)
const open = ref(false)
onMounted(refresh)
watch(() => props.objectId, refresh)
watch(open, (value) => {
  if (value) void refresh()
})
defineExpose({ refresh })
</script>

<template>
  <UPopover
    v-if="warnings.length > 0"
    v-model:open="open"
  >
    <UButton
      icon="i-lucide-triangle-alert"
      :label="t('shell.diagnosis.count', { n: warnings.length }, warnings.length)"
      color="warning"
      variant="soft"
    />
    <template #content>
      <div class="flex w-80 flex-col gap-2 p-3">
        <p class="text-sm font-medium">
          {{ t('shell.diagnosis.title') }}
        </p>
        <DiagnosisList
          :kind="kind"
          :object-id="objectId"
          :issues="issues"
        />
      </div>
    </template>
  </UPopover>
</template>
