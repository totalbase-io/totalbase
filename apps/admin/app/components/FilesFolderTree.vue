<script setup lang="ts">
/**
 * The Files page's folder tree - loading state, error, and one
 * FilesFolderTreeItem per root folder. The page shows it in its aside on
 * desktop and in a slideover on a phone (pages/files.vue). The item
 * props pass down; the event listeners (@select, @new-folder…) go
 * straight through to each item as attributes, so the page keeps all the
 * folder logic.
 */
import { useApiErrorMessage } from '~/utils/api-error-message'

defineOptions({ inheritAttrs: false })

const { t } = useI18n()
const errorMessage = useApiErrorMessage()

interface FolderTreeNode {
  id: string
  parent: string | null
  name: string
  createdAt: string
  updatedAt: string
  depth: number
  children: FolderTreeNode[]
}

defineProps<{
  tree: FolderTreeNode[]
  pending: boolean
  error: unknown
  selectedId: string
  editingId: string | null
  creatingParentId: string | null
  deletingId: string | null
}>()
</script>

<template>
  <div
    v-if="pending"
    class="flex items-center gap-2 px-2 py-3 text-sm text-muted"
  >
    <UIcon
      name="i-lucide-loader-circle"
      class="size-4 animate-spin"
    />
    {{ t('content.files.tree.loading') }}
  </div>
  <UAlert
    v-else-if="error"
    color="error"
    variant="subtle"
    :title="t('content.files.tree.loadError')"
    :description="error instanceof AdminApiError ? errorMessage(error) : undefined"
  />
  <template
    v-for="node in tree"
    v-else
    :key="node.id"
  >
    <FilesFolderTreeItem
      :node="node"
      :selected-id="selectedId"
      :editing-id="editingId"
      :creating-parent-id="creatingParentId"
      :deleting-id="deletingId"
      v-bind="$attrs"
    />
  </template>
</template>
