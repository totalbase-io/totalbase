<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.parse-file` node's `configuration`: which File
 * to read (a literal id with `{{...}}` support - see ReadFileModal.vue's
 * own doc comment for why) and which format to parse its content as.
 */

export interface ParseFileConfiguration {
  asset?: string
  format?: 'csv' | 'json'
}

const props = defineProps<{ modelValue: ParseFileConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ParseFileConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const filesApi = useFilesApi()
const { data: assets } = useAsyncData('parse-file-assets', () =>
  filesApi.listFiles(), { default: () => [] })
const assetItems = computed(() => (assets.value ?? [])
  .map(a => ({ label: a.name, onSelect: () => { asset.value = a.id } }))
  .sort((a, b) => a.label.localeCompare(b.label)))

const asset = ref('')
const format = ref<'csv' | 'json'>('csv')

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  asset.value = props.modelValue.asset ?? ''
  format.value = props.modelValue.format ?? 'csv'
})

function save() {
  emit('save', { key: keyValue.value, configuration: { asset: asset.value, format: format.value } })
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="$t('workflows.parseFileModal.parseCsvJson')"
    :description="$t('workflows.parseFileModal.convertAFileSContent')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UFormField
          :label="$t('workflows.parseFileModal.file')"
          required
          :description="$t('workflows.parseFileModal.aFileIdReferenceAnother', { c0: '{{stepKey.data.field}}', c1: '{{create_file.data.asset}}' })"
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
                :label="$t('workflows.parseFileModal.browse')"
                color="neutral"
                variant="outline"
              />
            </UDropdownMenu>
          </div>
        </UFormField>

        <UFormField :label="$t('workflows.parseFileModal.format')">
          <USelect
            v-model="format"
            :items="['csv', 'json']"
            class="w-40"
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
          :disabled="!asset || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
