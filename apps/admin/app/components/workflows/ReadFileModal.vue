<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.read-file` node's `configuration`: which File
 * to read - a literal string (a File id) with `{{operation.data.field}}`
 * support (apps/server/src/workflow-execution/templates.ts), so a step
 * earlier in the run (e.g. Create file) can produce the file id this step
 * reads, not just a fixed choice made at author time. The "Browse" menu is
 * a convenience that fills the field with an existing file's own id -
 * it doesn't constrain what can be typed there.
 */

export interface ReadFileConfiguration {
  asset?: string
}

const props = defineProps<{ modelValue: ReadFileConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ReadFileConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const filesApi = useFilesApi()
const { data: assets } = useAsyncData('read-file-assets', () =>
  filesApi.listFiles(), { default: () => [] })
const assetItems = computed(() => (assets.value ?? [])
  .map(a => ({ label: a.name, onSelect: () => { asset.value = a.id } }))
  .sort((a, b) => a.label.localeCompare(b.label)))

const asset = ref('')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  asset.value = props.modelValue.asset ?? ''
})

function save() {
  emit('save', { key: keyValue.value, configuration: { asset: asset.value } })
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="$t('workflows.readFileModal.readFile')"
    :description="$t('workflows.readFileModal.readAnExistingFile')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.readFileModal.file')"
          required
          :description="$t('workflows.readFileModal.aFileIdReferenceAnother', { c0: '{{stepKey.data.field}}', c1: '{{create_file.data.asset}}' })"
        >
          <div class="flex items-center gap-2">
            <UInput
              v-model="asset"
              class="w-full font-mono"
            />
            <UDropdownMenu
              :items="assetItems"
              :content="{ align: 'end' }"
            >
              <UButton
                :label="$t('workflows.readFileModal.browse')"
                color="neutral"
                variant="outline"
              />
            </UDropdownMenu>
          </div>
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
          :disabled="!asset || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
