<script setup lang="ts">
/**
 * The Style tab's Advanced: a widget's own Tailwind classes (`cssClass`), one
 * per row - the way Custom attributes edits HTML attributes. Stored as one
 * space-separated string; a row being typed stays until removed, an empty
 * one isn't saved.
 */
const model = defineModel<string | undefined>({ required: true })

const { t } = useI18n()
const rows = ref<string[]>([])
// Seeded from the stored classes - not while typing, which would drop an empty row.
watch(model, (value) => {
  if ((value ?? '') !== rows.value.map(r => r.trim()).filter(Boolean).join(' ')) rows.value = (value ?? '').split(/\s+/).filter(Boolean)
}, { immediate: true })
watch(rows, (list) => {
  // A row holds one class: spaces split it into several.
  const classes = list.flatMap(r => r.split(/\s+/)).filter(Boolean)
  const joined = classes.join(' ')
  if (joined !== (model.value ?? '')) model.value = joined || undefined
}, { deep: true })
</script>

<template>
  <UFormField
    :label="t('designer.designerClassListEditor.label')"
    :description="t('designer.designerClassListEditor.description')"
  >
    <div class="flex flex-col gap-2">
      <div
        v-for="(_, index) in rows"
        :key="index"
        class="grid grid-cols-[1fr_2rem] items-center gap-1.5"
      >
        <UInput
          v-model="rows[index]"
          :aria-label="t('designer.designerClassListEditor.classN', { n: index + 1 })"
          size="sm"
          class="w-full font-mono"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('designer.designerClassListEditor.removeClass')"
          @click="rows.splice(index, 1)"
        />
      </div>
      <UButton
        icon="i-lucide-plus"
        :label="t('designer.designerClassListEditor.addClass')"
        size="sm"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="rows.push('')"
      />
    </div>
  </UFormField>
</template>
