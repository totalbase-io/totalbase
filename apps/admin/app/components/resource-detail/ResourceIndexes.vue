<script setup lang="ts">
// Add/drop index - same create_index/drop_index operations and the same
// batch POST .../edit endpoint TableDrawer.vue's old Indexes tab used,
// just fired one at a time (no dry-run SQL preview, no accumulated diff)
// to match this page's other panels (ResourceConstraints.vue's Add Check,
// ResourceColumns.vue) autosave-per-action pattern instead of that
// drawer's own batch-diff-then-confirm one.
import type { TableColumn } from '@nuxt/ui'
import type { Resource } from '~/types/resource'
import type { EditOperationBody, IndexColumnBody, IndexDefinition, IndexMethod } from '~/types/schema'

const INDEX_METHODS: IndexMethod[] = ['btree', 'hash', 'gist', 'gin', 'spgist', 'brin']

const props = defineProps<{ resource: Resource }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const { data: indexes, pending, error, refresh } = await useAsyncData(
  () => `table-indexes-${props.resource.id}`,
  () => api.get<IndexDefinition[]>(`/catalog/table/${props.resource.id}/indexes`).then(r => r.data),
  { watch: [() => props.resource.id] }
)

// Only for the Columns multi-select below - the table's detail shared with the
// Columns and Check constraints panels (useTableDetail), so a column added
// there is offered here at once.
const { detail } = useTableDetail(() => props.resource.id)
const columnNames = computed(() => detail.value?.columns.map(c => c.name) ?? [])

const COLUMNS = computed<TableColumn<IndexDefinition>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { id: 'columns', header: t('database.resourceIndexes.columns') },
  { id: 'kind', header: t('database.resourceIndexes.kind') },
  { accessorKey: 'method', header: t('database.resourceIndexes.method') },
  { id: 'actions', header: '', meta: { class: { td: 'text-right' } } }
])

async function runOperation(op: EditOperationBody) {
  await api.post(`/schema/${props.resource.schema}/tables/${props.resource.name}/edit`, { data: { operations: [op] } })
}

// --- Add index ---
const isAddOpen = ref(false)
const draftName = ref('')
const draftColumns = ref<string[]>([])
const draftDirections = ref<Record<string, 'asc' | 'desc'>>({})
const draftMethod = ref<IndexMethod>('btree')
const draftUnique = ref(false)
const draftWhere = ref('')
const draftConcurrently = ref(false)
const saving = ref(false)

function openAdd() {
  draftName.value = ''
  draftColumns.value = []
  draftDirections.value = {}
  draftMethod.value = 'btree'
  draftUnique.value = false
  draftWhere.value = ''
  draftConcurrently.value = false
  isAddOpen.value = true
}

async function addIndex() {
  if (draftColumns.value.length === 0) return
  saving.value = true
  try {
    const columns: IndexColumnBody[] = draftColumns.value.map(name =>
      draftDirections.value[name] === 'desc' ? { name, direction: 'desc' } : { name }
    )
    await runOperation({
      kind: 'create_index',
      name: draftName.value.trim() || undefined,
      columns,
      method: draftMethod.value,
      unique: draftUnique.value || undefined,
      where: draftWhere.value.trim() || undefined,
      concurrently: draftConcurrently.value || undefined
    })
    toast.add({ title: t('database.resourceIndexes.created'), color: 'success' })
    isAddOpen.value = false
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceIndexes.createError'))
  } finally {
    saving.value = false
  }
}

// --- Drop index ---
const removing = ref<string | null>(null)
async function removeIndex(name: string) {
  removing.value = name
  try {
    await runOperation({ kind: 'drop_index', name })
    toast.add({ title: t('database.resourceIndexes.dropped'), color: 'success' })
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceIndexes.dropError'))
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <SettingsSection :title="t('database.resourceIndexes.title')">
    <template #actions>
      <UButton
        :label="t('database.resourceIndexes.addIndex')"
        icon="i-lucide-plus"
        size="sm"
        color="neutral"
        variant="outline"
        :disabled="detail?.canAlter === false"
        @click="openAdd"
      />
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <UEmpty
      v-if="pending"
      loading
      variant="naked"
      size="sm"
    />

    <template v-else-if="indexes">
      <UEmpty
        v-if="indexes.length === 0"
        variant="naked"
        size="sm"
        icon="i-lucide-list-ordered"
        :title="t('database.resourceIndexes.empty')"
      />

      <UTable
        v-else
        sticky
        :data="indexes"
        :columns="COLUMNS"
      >
        <template #name-cell="{ row }">
          <span class="font-mono text-xs font-medium text-highlighted">{{ row.original.name }}</span>
        </template>
        <template #columns-cell="{ row }">
          {{ row.original.columns.join(', ') }}
        </template>
        <template #kind-cell="{ row }">
          <UBadge
            v-if="row.original.isPrimary"
            color="primary"
            variant="subtle"
            size="sm"
          >
            {{ t('database.resourceIndexes.primary') }}
          </UBadge>
          <UBadge
            v-else-if="row.original.isUnique"
            color="neutral"
            variant="subtle"
            size="sm"
          >
            {{ t('database.resourceIndexes.unique') }}
          </UBadge>
          <UBadge
            v-else
            color="neutral"
            variant="outline"
            size="sm"
          >
            {{ t('database.resourceIndexes.index') }}
          </UBadge>
        </template>
        <template #actions-cell="{ row }">
          <ConfirmDeletePopover
            v-if="!row.original.isPrimary && detail?.canAlter !== false"
            :title="t('database.resourceIndexes.deleteTitle')"
            :description="t('database.resourceIndexes.deleteDescription', { name: row.original.name })"
            @confirm="removeIndex(row.original.name)"
          >
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              :aria-label="t('database.resourceIndexes.deleteAria', { name: row.original.name })"
              :loading="removing === row.original.name"
            />
          </ConfirmDeletePopover>
        </template>
      </UTable>
    </template>

    <!-- Add index -->
    <UModal
      v-model:open="isAddOpen"
      :title="t('database.resourceIndexes.modalTitle')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            :label="t('common.name')"
            :description="t('database.resourceIndexes.nameDescription')"
          >
            <InputPgIdentifier
              v-model="draftName"
              class="w-full"
            />
          </UFormField>

          <div class="flex items-center gap-2">
            <USwitch
              v-model="draftUnique"
              :aria-label="t('database.resourceIndexes.unique')"
            />
            <span class="text-sm">{{ t('database.resourceIndexes.unique') }}</span>
          </div>

          <div class="flex flex-col gap-4 border-t border-default pt-4">
            <UFormField
              :label="t('database.resourceIndexes.columns')"
              required
            >
              <USelectMenu
                v-model="draftColumns"
                multiple
                :items="columnNames"
                class="w-full"
              />
            </UFormField>

            <!-- Per-column sort direction - a plain column sorts ASC
            (Postgres's own default), only worth showing once columns are
            actually picked. -->
            <div
              v-if="draftColumns.length > 0"
              class="flex flex-col gap-2"
            >
              <p class="text-xs font-medium text-muted">
                {{ t('database.resourceIndexes.order') }}
              </p>
              <div
                v-for="col in draftColumns"
                :key="col"
                class="flex items-center gap-2"
              >
                <span class="text-sm truncate flex-1">{{ col }}</span>
                <USelect
                  :aria-label="`${col} - ${t('common.direction')}`"
                  :model-value="draftDirections[col] ?? 'asc'"
                  :items="['asc', 'desc']"
                  size="sm"
                  class="w-28"
                  @update:model-value="(v: string) => { draftDirections[col] = v as 'asc' | 'desc' }"
                />
              </div>
            </div>

            <UFormField :label="t('database.resourceIndexes.method')">
              <USelect
                v-model="draftMethod"
                :items="INDEX_METHODS"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="flex flex-col gap-4 border-t border-default pt-4">
            <UFormField
              :label="t('database.resourceIndexes.where')"
              :description="t('database.resourceIndexes.whereDescription')"
            >
              <UInput
                v-model="draftWhere"
                class="w-full font-mono text-xs"
              />
            </UFormField>

            <div class="flex items-center gap-2">
              <USwitch
                v-model="draftConcurrently"
                :aria-label="t('database.resourceIndexes.concurrently')"
              />
              <span class="text-sm">{{ t('database.resourceIndexes.concurrently') }}</span>
              <UTooltip :text="t('database.resourceIndexes.concurrentlyHint')">
                <UIcon
                  name="i-lucide-info"
                  class="text-muted size-4"
                />
              </UTooltip>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="isAddOpen = false"
          />
          <UButton
            :label="t('common.add')"
            :loading="saving"
            :disabled="draftColumns.length === 0"
            @click="addIndex"
          />
        </div>
      </template>
    </UModal>
  </SettingsSection>
</template>
