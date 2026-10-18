<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.create-file` node's `configuration`: a name,
 * MIME type, and `content` - a literal string with `{{operation.data.
 * field}}` support (apps/server/src/workflow-execution/templates.ts),
 * same conversion every other catalog field went through - must resolve
 * to a string, stored as a new Asset: as text, or decoded from base64 for
 * binary content another step produced (a PDF). `folder` - where it goes.
 */
export interface CreateFileConfiguration {
  name?: string
  contentType?: string
  content?: string
  encoding?: 'text' | 'base64'
  folder?: string | null
}

const props = defineProps<{ modelValue: CreateFileConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: CreateFileConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const name = ref('')
const contentType = ref('text/plain')
const content = ref('')
const encoding = ref<'text' | 'base64'>('text')
const folder = ref<string | null | undefined>(undefined)

const filesApi = useFilesApi()
const { data: folders } = useAsyncData('create-file-folders', () => filesApi.listFolders(), { default: () => [] })
/** Each folder with its full path ("Facturas / 2026"), so same-named subfolders stay tellable apart. */
const folderItems = computed(() => {
  const byId = new Map(folders.value.map(f => [f.id, f]))
  const pathOf = (id: string): string => {
    const node = byId.get(id)
    if (!node) return ''
    return node.parent ? `${pathOf(node.parent)} / ${node.name}` : node.name
  }
  return folders.value.map(f => ({ label: pathOf(f.id), value: f.id })).sort((a, b) => a.label.localeCompare(b.label))
})

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  name.value = props.modelValue.name ?? ''
  contentType.value = props.modelValue.contentType ?? 'text/plain'
  content.value = props.modelValue.content ?? ''
  encoding.value = props.modelValue.encoding ?? 'text'
  folder.value = props.modelValue.folder ?? undefined
})

function save() {
  emit('save', { key: keyValue.value, configuration: { name: name.value, contentType: contentType.value, content: content.value, encoding: encoding.value, folder: folder.value ?? null } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.createFileModal.createFile')"
    :description="$t('workflows.createFileModal.storeGeneratedContentAsA')"
    :ui="{ content: isCompact ? undefined : 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <!-- Stacked on a phone - a 180px field beside the name left it ~140px. -->
        <div class="flex gap-3 max-md:flex-col">
          <UFormField
            :label="$t('common.name')"
            required
            class="flex-1"
          >
            <UInput
              v-model="name"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="$t('workflows.createFileModal.contentType')"
            :description="$t('workflows.createFileModal.forExampleTextPlain')"
            class="w-48 shrink-0 max-md:w-full"
          >
            <UInput
              v-model="contentType"
              class="w-full font-mono"
            />
          </UFormField>
        </div>

        <div class="flex gap-3 max-md:flex-col">
          <UFormField
            :label="$t('workflows.createFileModal.folder')"
            :description="$t('workflows.createFileModal.whereTheFileIsStored')"
            class="flex-1"
          >
            <USelectMenu
              v-model="folder"
              :items="folderItems"
              value-key="value"
              searchable
              clear
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="$t('workflows.createFileModal.encoding')"
            :description="$t('workflows.createFileModal.base64BinaryContentFromAnother')"
            class="w-48 shrink-0 max-md:w-full"
          >
            <USelect
              v-model="encoding"
              :items="[{ label: $t('workflows.createFileModal.encodingText'), value: 'text' }, { label: 'Base64', value: 'base64' }]"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          :label="$t('workflows.createFileModal.content')"
          :description="$t('workflows.createFileModal.theAssetSContentText', { c0: '{{stepKey.data.field}}', c1: '{{start.data...}}' })"
        >
          <UTextarea
            v-model="content"
            :rows="6"
            class="w-full font-mono"
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
          :disabled="!name || !keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
