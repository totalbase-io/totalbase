<script setup lang="ts">
interface FolderTreeNode {
  id: string
  parent: string | null
  name: string
  createdAt: string
  updatedAt: string
  depth: number
  children: FolderTreeNode[]
}

const props = withDefaults(defineProps<{
  node: FolderTreeNode
  selectedId: string
  editingId: string | null
  creatingParentId: string | null
  deletingId?: string | null
}>(), {
  deletingId: null
})

const emit = defineEmits<{
  select: [id: string]
  newFolder: [id: string]
  uploadFile: [id: string]
  renameFolder: [id: string]
  confirmDelete: [id: string]
  deleteFolder: [id: string]
  cancelDelete: []
  saveCreate: [parentId: string, value: string]
  cancelCreate: []
  saveRename: [id: string, value: string]
  cancelRename: []
}>()

const { t } = useI18n()
const renameDraft = ref('')
const createDraft = ref('')
const ignoreCloseUntil = ref(0)
const actionContentRef = ref<HTMLElement | null>(null)
const activeAction = computed<'create' | 'rename' | 'delete' | null>(() => {
  if (props.creatingParentId === props.node.id) return 'create'
  if (props.editingId === props.node.id) return 'rename'
  if (props.deletingId === props.node.id) return 'delete'
  return null
})
const isActionOpen = computed(() => activeAction.value !== null)

function displayName(node: FolderTreeNode): string {
  return node.id === 'root' ? t('content.files.tree.root') : node.name
}

// Only the folder actions the caller's permissions on folders allow.
const session = useSession()
const menuItems = computed(() => [[
  ...(session.can('folders', 'CREATE') ? [{ label: t('common.new'), icon: 'i-lucide-folder-plus', onSelect: () => window.setTimeout(() => emit('newFolder', props.node.id), 75) }] : []),
  ...(session.can('files', 'CREATE') ? [{ label: t('content.files.tree.uploadFile'), icon: 'i-lucide-upload', onSelect: () => emit('uploadFile', props.node.id) }] : []),
  ...(session.can('folders', 'UPDATE') ? [{ label: t('common.rename'), icon: 'i-lucide-pencil', disabled: props.node.id === 'root', onSelect: () => window.setTimeout(() => emit('renameFolder', props.node.id), 75) }] : []),
  ...(session.can('folders', 'DELETE')
    ? [{ type: 'separator' as const }, { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, disabled: props.node.id === 'root', onSelect: () => window.setTimeout(() => emit('confirmDelete', props.node.id), 75) }]
    : [])
]])

watch(activeAction, (action) => {
  if (action) ignoreCloseUntil.value = Date.now() + 250
  if (action === 'create' || action === 'rename') {
    nextTick(() => {
      actionContentRef.value?.querySelector('input')?.focus()
    })
  }
})

watch(() => props.editingId, (id) => {
  if (id === props.node.id) renameDraft.value = props.node.name
}, { immediate: true })

watch(() => props.creatingParentId, (id) => {
  if (id === props.node.id) createDraft.value = ''
}, { immediate: true })

function closeAction() {
  if (Date.now() < ignoreCloseUntil.value) return
  if (activeAction.value === 'create') emit('cancelCreate')
  else if (activeAction.value === 'rename') emit('cancelRename')
  else if (activeAction.value === 'delete') emit('cancelDelete')
}
</script>

<template>
  <div>
    <UPopover
      :open="isActionOpen"
      @update:open="(open: boolean) => { if (!open) closeAction() }"
    >
      <UContextMenu
        :items="menuItems"
        size="sm"
      >
        <div
          class="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-elevated"
          :class="props.node.id === props.selectedId ? 'bg-elevated text-highlighted' : 'text-default'"
          :style="{ paddingLeft: `${8 + props.node.depth * 16}px` }"
        >
          <UIcon
            :name="props.node.id === 'root' ? 'i-lucide-hard-drive' : 'i-lucide-folder'"
            class="size-4 shrink-0 text-muted"
          />
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left"
            @click="emit('select', props.node.id)"
          >
            {{ displayName(props.node) }}
          </button>
          <UDropdownMenu
            :items="menuItems"
            size="sm"
          >
            <UButton
              :aria-label="t('common.actions')"
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              square
              class="opacity-0 group-hover:opacity-100 focus:opacity-100"
              @click.stop
            />
          </UDropdownMenu>
        </div>
      </UContextMenu>

      <template #content>
        <form
          v-if="activeAction === 'create'"
          ref="actionContentRef"
          class="w-64 space-y-3 p-3"
          @submit.prevent="emit('saveCreate', props.node.id, createDraft)"
        >
          <UFormField
            :label="t('common.name')"
            :description="t('content.files.tree.createdInside', { name: props.node.id === 'root' ? '/' : props.node.name })"
          >
            <UInput
              v-model="createDraft"
              autofocus
              @keydown.esc.prevent="emit('cancelCreate')"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="emit('cancelCreate')"
            />
            <UButton
              :label="t('common.create')"
              icon="i-lucide-check"
              size="sm"
              type="submit"
            />
          </div>
        </form>

        <form
          v-else-if="activeAction === 'rename'"
          ref="actionContentRef"
          class="w-64 space-y-3 p-3"
          @submit.prevent="emit('saveRename', props.node.id, renameDraft)"
        >
          <UFormField :label="t('common.name')">
            <UInput
              v-model="renameDraft"
              autofocus
              @keydown.esc.prevent="emit('cancelRename')"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="emit('cancelRename')"
            />
            <UButton
              :label="t('common.save')"
              icon="i-lucide-check"
              size="sm"
              type="submit"
            />
          </div>
        </form>

        <div
          v-else-if="activeAction === 'delete'"
          class="w-64 space-y-3 p-3"
        >
          <p class="text-sm text-default">
            <i18n-t
              keypath="content.files.tree.deleteConfirm"
              scope="global"
            >
              <template #name>
                <span class="font-medium">{{ props.node.name }}</span>
              </template>
            </i18n-t>
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="emit('cancelDelete')"
            />
            <UButton
              :label="t('common.delete')"
              icon="i-lucide-trash-2"
              color="error"
              size="sm"
              @click="emit('deleteFolder', props.node.id)"
            />
          </div>
        </div>
      </template>
    </UPopover>
    <FilesFolderTreeItem
      v-for="child in props.node.children"
      :key="child.id"
      :node="child"
      :selected-id="props.selectedId"
      :editing-id="props.editingId"
      :creating-parent-id="props.creatingParentId"
      :deleting-id="props.deletingId"
      @select="emit('select', $event)"
      @new-folder="emit('newFolder', $event)"
      @upload-file="emit('uploadFile', $event)"
      @rename-folder="emit('renameFolder', $event)"
      @confirm-delete="emit('confirmDelete', $event)"
      @delete-folder="emit('deleteFolder', $event)"
      @cancel-delete="emit('cancelDelete')"
      @save-create="(id, value) => emit('saveCreate', id, value)"
      @cancel-create="emit('cancelCreate')"
      @save-rename="(id, value) => emit('saveRename', id, value)"
      @cancel-rename="emit('cancelRename')"
    />
  </div>
</template>
