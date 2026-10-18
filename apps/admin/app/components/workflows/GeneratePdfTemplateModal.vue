<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.generate-pdf-template` node's `configuration`:
 * a saved PDF Template (Templates module, kind: 'PDF') plus the data to
 * fill its placeholders with, as a static JSON object.
 */

export interface GeneratePdfTemplateConfiguration {
  template?: string
  data?: Record<string, unknown>
}

const props = defineProps<{ modelValue: GeneratePdfTemplateConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: GeneratePdfTemplateConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const templatesApi = useTemplatesApi()
const { data: templates } = useAsyncData('generate-pdf-templates', () =>
  templatesApi.list().then(list => list.filter(template => template.kind === 'PDF')), { default: () => [] })
const templateOptions = computed(() => (templates.value ?? []).map(template => ({ label: template.name, value: template.id })).sort((a, b) => a.label.localeCompare(b.label)))

const templateId = ref<string | undefined>(undefined)
const dataJson = ref('{}')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  templateId.value = props.modelValue.template
  dataJson.value = JSON.stringify(props.modelValue.data ?? {}, null, 2)
})

const { t } = useI18n()
const dataError = computed(() => {
  try {
    const parsed = JSON.parse(dataJson.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : t('workflows.json.mustBeObject')
  } catch {
    return t('workflows.json.invalid')
  }
})
const editorRef = ref<{ format: () => void } | null>(null)

function save() {
  const data = dataError.value ? {} : JSON.parse(dataJson.value)
  emit('save', { key: keyValue.value, configuration: { template: templateId.value, data } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.generatePdfTemplateModal.generatePdfFromTemplate')"
    :description="$t('workflows.generatePdfTemplateModal.fillASavedPdfmeTemplate')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.generatePdfTemplateModal.template')"
          required
          :description="$t('workflows.generatePdfTemplateModal.aPdfTemplateFromThe')"
        >
          <USelectMenu
            v-model="templateId"
            :items="templateOptions"
            value-key="value"
            searchable
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="$t('workflows.generatePdfTemplateModal.data')"
          :error="dataError ?? undefined"
          :description="$t('workflows.generatePdfTemplateModal.aJsonObjectValuesFor')"
        >
          <div class="flex items-center justify-end gap-1 pb-2">
            <UButton
              :label="$t('workflows.generatePdfTemplateModal.format')"
              icon="i-lucide-wand-sparkles"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="editorRef?.format()"
            />
          </div>
          <JsonEditor
            ref="editorRef"
            v-model="dataJson"
            min-height="10rem"
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
          :disabled="!templateId || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
