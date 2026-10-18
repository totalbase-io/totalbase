<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.generate-pdf` node's `configuration`: a custom
 * pdfme design (the same `{ basePdf, schemas }` shape Templates' own PDF
 * kind stores) plus the data to fill it with - both raw JSON for now.
 * A visual designer (reusing PdfTemplateDesigner.vue) is a natural
 * follow-up, deferred so this step ships without embedding that heavier
 * editor inside a workflow node's modal in this pass.
 */
export interface GeneratePdfConfiguration {
  design?: Record<string, unknown>
  data?: Record<string, unknown>
}

const props = defineProps<{ modelValue: GeneratePdfConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: GeneratePdfConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

// pdfme's own blank starting point (matches templates.vue's BLANK_PDF_CONTENT).
const BLANK_DESIGN = { basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] }, schemas: [[]] }

const designJson = ref('{}')
const dataJson = ref('{}')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  designJson.value = JSON.stringify(props.modelValue.design ?? BLANK_DESIGN, null, 2)
  dataJson.value = JSON.stringify(props.modelValue.data ?? {}, null, 2)
})

const { t } = useI18n()
const designError = computed(() => {
  try {
    const parsed = JSON.parse(designJson.value)
    return parsed && typeof parsed === 'object' ? null : t('workflows.json.mustBeObject')
  } catch {
    return t('workflows.json.invalid')
  }
})
const dataError = computed(() => {
  try {
    const parsed = JSON.parse(dataJson.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : t('workflows.json.mustBeObject')
  } catch {
    return t('workflows.json.invalid')
  }
})
const designEditorRef = ref<{ format: () => void } | null>(null)
const dataEditorRef = ref<{ format: () => void } | null>(null)

function save() {
  const design = designError.value ? BLANK_DESIGN : JSON.parse(designJson.value)
  const data = dataError.value ? {} : JSON.parse(dataJson.value)
  emit('save', { key: keyValue.value, configuration: { design, data } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.generatePdfModal.generatePdf')"
    :description="$t('workflows.generatePdfModal.buildAPdfFromA')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.generatePdfModal.design')"
          :error="designError ?? undefined"
          :description="$t('workflows.generatePdfModal.aPdfmeDesignObjectBasepdf')"
        >
          <div class="flex items-center justify-end gap-1 pb-2">
            <UButton
              :label="$t('workflows.generatePdfModal.format')"
              icon="i-lucide-wand-sparkles"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="designEditorRef?.format()"
            />
          </div>
          <JsonEditor
            ref="designEditorRef"
            v-model="designJson"
            min-height="10rem"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.generatePdfModal.data')"
          :error="dataError ?? undefined"
          :description="$t('workflows.generatePdfModal.aJsonObjectValuesFor')"
        >
          <div class="flex items-center justify-end gap-1 pb-2">
            <UButton
              :label="$t('workflows.generatePdfModal.format')"
              icon="i-lucide-wand-sparkles"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="dataEditorRef?.format()"
            />
          </div>
          <JsonEditor
            ref="dataEditorRef"
            v-model="dataJson"
            min-height="8rem"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="$t('common.cancel')"
          @click="open = false"
        />
        <UButton
          :label="$t('common.save')"
          :disabled="!keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
