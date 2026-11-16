<script setup lang="ts">
import type { EditOperationBody, RelationDetail } from '~/types/schema'

/**
 * TABLE detail rendered by the canonical resource route. The route uses the TotalBase resource UUID, which remains
 * stable across PostgreSQL renames. Sections stack top-to-bottom so a builder can scan the real structure in one
 * pass; Endpoints and Auditing come last - exposure is what you touch once you're done reviewing the structure.
 */
const route = useRoute()
const resourceId = computed(() => route.params.id as string)
const resourcesApi = useResourcesApi()
const { t } = useI18n()

const { data: resource, pending, error } = await useAsyncData(
  () => `table-detail-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)

// Whether TotalBase's PostgreSQL role may change this table's structure (Administration.md §3.15) - from the
// Columns section's own catalog read, so the page doesn't fetch it twice. Unknown until loaded: nothing is
// disabled on a guess.
const ownership = ref<Pick<RelationDetail, 'owner' | 'canAlter'> | null>(null)
watch(resourceId, () => {
  ownership.value = null
})
const notOwned = computed(() => ownership.value?.canAlter === false)

// --- Rename (Administration.md §3): ALTER TABLE ... RENAME, its SQL shown before Apply. The resource keeps its id
// (its OID doesn't change), so the page stays; what lists tables by name refreshes. ---
const renameOpen = ref(false)
const newName = ref('')
watch(renameOpen, (isOpen) => {
  if (isOpen) newName.value = resource.value?.name ?? ''
})
const renameEdit = useTableEdit(() => ({ schema: resource.value?.schema ?? '', name: resource.value?.name ?? '' }))
const renameOperations = computed<EditOperationBody[]>(() => {
  const next = newName.value.trim()
  return next && next !== resource.value?.name ? [{ kind: 'rename_table', newName: next }] : []
})
async function applyRename() {
  if (!(await renameEdit.apply(renameOperations.value)) || !resource.value) return
  renameOpen.value = false
  resource.value = await resourcesApi.get(resource.value.id)
  await Promise.all([refreshResourcesList(), refreshSchemasList()])
}

// The data browser reads through the Data API: with GET turned off under Endpoints there is nothing it could show.
const canBrowseData = computed(() => resource.value?.exposedMethods.includes('GET') ?? false)
const browseData = () => {
  if (resource.value && canBrowseData.value) navigateTo(`/resources/${resource.value.id}/data`)
}
</script>

<template>
  <NuxtPage v-if="route.path.endsWith('/data')" />
  <ResourceDetailShell
    v-else
    :resource="resource"
    :pending="pending"
    :error="error"
    :load-error="t('database.tableResourceDetail.loadError')"
  >
    <template #default="{ resource: table }">
      <ResourceDataSection
        :resource="table"
        @update:resource="next => resource = next"
      >
        <template #note>
          <NotOwnedNote
            v-if="notOwned"
            kind="table"
            :owner="ownership!.owner"
          />
        </template>
        <template #rename>
          <UPopover v-model:open="renameOpen">
            <UButton
              :label="t('database.tableEdit.rename')"
              icon="i-lucide-text-cursor-input"
              color="neutral"
              variant="outline"
              :disabled="notOwned"
            />
            <template #content>
              <div class="flex w-96 flex-col gap-3 p-3">
                <UFormField
                  :label="t('database.tableEdit.newName')"
                  :description="t('database.tableEdit.renameHelp')"
                >
                  <UInput
                    v-model="newName"
                    class="w-full"
                  />
                </UFormField>
                <TableEditSqlPreview
                  :schema="table.schema"
                  :table="table.name"
                  :operations="renameOperations"
                />
                <div class="flex justify-end">
                  <UButton
                    :label="t('database.tableEdit.apply')"
                    size="sm"
                    :loading="renameEdit.saving.value"
                    :disabled="renameOperations.length === 0"
                    @click="applyRename"
                  />
                </div>
              </div>
            </template>
          </UPopover>
        </template>
      </ResourceDataSection>

      <ResourceCreateActions :resource="table">
        <!-- The span carries the tooltip: a disabled button gets no pointer events. -->
        <UTooltip
          :text="t('database.tableResourceDetail.browseDataNeedsGet')"
          :disabled="canBrowseData"
        >
          <span class="inline-flex">
            <UButton
              :label="t('database.tableResourceDetail.browseData')"
              icon="i-lucide-sheet"
              color="primary"
              variant="solid"
              :disabled="!canBrowseData"
              @click="browseData"
            />
          </span>
        </UTooltip>
      </ResourceCreateActions>

      <section>
        <ResourceColumns
          :resource="table"
          :open-presentation="typeof route.query.presentation === 'string' ? route.query.presentation : undefined"
          @loaded="(detail: RelationDetail) => ownership = { owner: detail.owner, canAlter: detail.canAlter }"
        />
      </section>

      <section>
        <ResourceIndexes :resource="table" />
      </section>

      <section>
        <ResourceConstraints :resource="table" />
      </section>

      <section>
        <ResourceDataViews :resource="table" />
      </section>

      <ResourceEndpoints
        :resource="table"
        @update:resource="next => resource = next"
      >
        <ResourceIdempotencyKey
          :resource="table"
          @update:resource="next => resource = next"
        />
      </ResourceEndpoints>

      <ResourceAuditing
        :key="table.id"
        :resource="table"
        @update:resource="next => resource = next"
      />

      <ResourceDangerZone
        :resource="table"
        :ownership="ownership"
      />
    </template>
  </ResourceDetailShell>
</template>
