<script setup lang="ts">
import { DATAVIEW_TYPE_META, dataviewMetaKey } from '~/types/dataview'
import type { DataView } from '~/types/dataview'
import type { TableColumn } from '@nuxt/ui'
import type { Resource } from '~/types/resource'

const props = defineProps<{ resource: Resource }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const catalogText = useCatalogText()
const notifyError = useErrorToast()
const { dataviews, loading, error, refresh } = useAppsNavDataViews()

const relatedDataViews = computed(() => (dataviews.value ?? [])
  .filter(dataview => dataview.sourceResource === props.resource.id)
  .sort((a, b) => a.name.localeCompare(b.name)))

const COLUMNS = computed<TableColumn<DataView>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { id: 'type', header: t('common.type') },
  { id: 'slug', header: t('database.resourceDataViews.slug') },
  { id: 'actions', header: t('common.actions'), meta: { class: { th: 'text-right' } } }
])

const deleteTarget = ref<DataView | null>(null)
const deleteConfirmed = ref(false)
const deleting = ref(false)

function openDelete(dataview: DataView) {
  deleteTarget.value = dataview
  deleteConfirmed.value = false
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await api.del(`/dataviews/${deleteTarget.value.id}`)
    toast.add({ title: t('database.resourceDataViews.deleted'), color: 'success' })
    deleteTarget.value = null
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceDataViews.deleteError'))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <SettingsSection :title="t('database.resourceDataViews.title')">
    <template #actions>
      <UBadge
        :label="String(relatedDataViews.length)"
        color="neutral"
        variant="subtle"
        size="sm"
      />
    </template>
    <i18n-t
      keypath="database.resourceDataViews.intro"
      tag="p"
      class="text-sm text-muted"
    >
      <template #name>
        <span class="font-medium text-default">{{ resource.schema }}.{{ resource.name }}</span>
      </template>
    </i18n-t>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('database.resourceDataViews.loadError')"
    />

    <UEmpty
      v-else-if="loading"
      loading
      variant="naked"
      size="sm"
    />

    <UEmpty
      v-else-if="relatedDataViews.length === 0"
      variant="naked"
      size="sm"
      icon="i-lucide-layout-panel-left"
      :title="t('database.resourceDataViews.empty')"
    />

    <UTable
      v-else
      sticky
      :data="relatedDataViews"
      :columns="COLUMNS"
    >
      <template #name-cell="{ row }">
        <div class="flex min-w-0 items-center gap-2">
          <UIcon
            :name="row.original.icon || DATAVIEW_TYPE_META[row.original.viewType].icon"
            class="size-4 shrink-0 text-muted"
          />
          <span class="truncate font-medium text-highlighted">{{ row.original.name }}</span>
        </div>
        <p
          v-if="row.original.description"
          class="mt-0.5 truncate text-xs"
        >
          {{ row.original.description }}
        </p>
      </template>
      <template #type-cell="{ row }">
        <UBadge
          :label="catalogText(dataviewMetaKey('types', row.original.viewType, 'label'), DATAVIEW_TYPE_META[row.original.viewType].label)"
          color="neutral"
          variant="subtle"
          size="sm"
        />
      </template>
      <template #slug-cell="{ row }">
        <span class="font-mono text-xs">{{ row.original.slug }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton
            :aria-label="t('common.settings')"
            icon="i-lucide-settings"
            size="xs"
            color="neutral"
            variant="ghost"
            :to="`/dataviews/${row.original.id}/settings`"
          />
          <UButton
            :aria-label="t('common.open')"
            icon="i-lucide-external-link"
            size="xs"
            color="neutral"
            variant="ghost"
            :disabled="row.original.liveVersion == null"
            :to="`/app/dataviews/${row.original.slug}`"
          />
          <UButton
            :aria-label="t('common.delete')"
            icon="i-lucide-trash-2"
            size="xs"
            color="error"
            variant="ghost"
            @click="openDelete(row.original)"
          />
        </div>
      </template>
    </UTable>

    <UModal
      :open="!!deleteTarget"
      :title="t('database.resourceDataViews.deleteModalTitle')"
      @update:open="(value: boolean) => { if (!value) deleteTarget = null }"
    >
      <template #body>
        <div
          v-if="deleteTarget"
          class="flex flex-col gap-4"
        >
          <i18n-t
            keypath="database.resourceDataViews.deleteBody"
            tag="p"
            class="text-sm text-muted"
          >
            <template #name>
              <span class="font-medium text-default">{{ deleteTarget.name }}</span>
            </template>
          </i18n-t>
          <div class="flex items-center justify-between gap-2 border-t border-default pt-4">
            <label class="flex cursor-pointer items-center gap-2">
              <UCheckbox v-model="deleteConfirmed" />
              <span class="text-sm">{{ t('common.confirm') }}</span>
            </label>
            <div class="flex gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="ghost"
                :disabled="deleting"
                @click="deleteTarget = null"
              />
              <UButton
                :label="t('common.delete')"
                color="error"
                :disabled="!deleteConfirmed"
                :loading="deleting"
                @click="confirmDelete"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </SettingsSection>
</template>
