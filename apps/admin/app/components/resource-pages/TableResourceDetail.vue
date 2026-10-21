<script setup lang="ts">
import type { DataApiMethod, Resource } from '~/types/resource'
import type { DataView } from '~/types/dataview'
import type { RelationDetail } from '~/types/schema'
import { APPLICABLE_METHODS } from '~/types/resource'
import { useApiErrorMessage } from '~/utils/api-error-message'

/**
 * TABLE detail rendered by the canonical resource route. The route uses the
 * TotalBase resource UUID, which remains stable across PostgreSQL renames.
 * Sections stack top-to-bottom so a builder can scan the real structure in
 * one pass.
 */
const route = useRoute()
const resourceId = computed(() => route.params.id as string)

const api = useAdminApi()
const resourcesApi = useResourcesApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const { data: resource, pending, error } = await useAsyncData(
  () => `table-detail-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)

// --- Description (TotalBase's own metadata, a plain column - not a
// PostgreSQL COMMENT ON) - a plain always-editable textarea, autosaving on
// blur (matches settings.vue's Columns group: "Saves automatically as you
// go", no separate Save/Cancel pair to manage). Reset only when the
// resource itself changes (a different oid), not on every re-fetch caused
// by our own save below - otherwise typing would race its own PATCH. ---
const descriptionDraft = ref(resource.value?.description ?? '')
watch(() => resource.value?.id, () => {
  descriptionDraft.value = resource.value?.description ?? ''
})

const savingDescription = ref(false)

async function saveDescription() {
  if (!resource.value) return
  const next = descriptionDraft.value.trim() === '' ? null : descriptionDraft.value.trim()
  if (next === resource.value.description) return
  const id = resource.value.id
  savingDescription.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${id}`, { data: { description: next } })
    resource.value = data
  } catch (err) {
    notifyError(err, t('database.resourceDetail.descriptionUpdateError'))
  } finally {
    savingDescription.value = false
  }
}

// --- Endpoints (autosaving switches, one per applicable method - same
// PATCH ResourcesBrowser.vue's drawer used behind its old modal, just
// fired per-toggle instead of batched behind a Save button). ---
const endpointsSaving = ref<DataApiMethod | null>(null)

function endpointPath(method: DataApiMethod): string {
  const base = `/api/${resource.value!.schema}/${resource.value!.type.toLowerCase()}/${resource.value!.name}`
  return method === 'GET' || method === 'POST' ? base : `${base}/{pk}`
}

function methodColor(method: DataApiMethod) {
  return { GET: 'info', POST: 'success', PATCH: 'warning', DELETE: 'error' }[method] as 'info' | 'success' | 'warning' | 'error'
}

async function toggleEndpoint(method: DataApiMethod, enabled: boolean) {
  if (!resource.value) return
  const id = resource.value.id
  const next = enabled
    ? [...resource.value.exposedMethods, method]
    : resource.value.exposedMethods.filter(m => m !== method)
  endpointsSaving.value = method
  try {
    const { data } = await api.patch<Resource>(`/resources/${id}`, { data: { exposedMethods: next } })
    resource.value = data
    await refreshResourcesList()
  } catch (err) {
    notifyError(err, t('database.tableResourceDetail.endpointUpdateError'))
  } finally {
    endpointsSaving.value = null
  }
}

// Whether TotalBase's PostgreSQL role may change this table's structure
// (Administration.md §3.15) - from the Columns section's own
// catalog read, so the page doesn't fetch it twice. Unknown until loaded:
// nothing is disabled on a guess.
const ownership = ref<Pick<RelationDetail, 'owner' | 'canAlter'> | null>(null)
watch(resourceId, () => {
  ownership.value = null
})
const notOwned = computed(() => ownership.value?.canAlter === false)

// --- Danger zone: drop table ---
const router = useRouter()
// The data browser reads through the Data API: with GET turned off under
// Endpoints there is nothing it could show.
const canBrowseData = computed(() => resource.value?.exposedMethods.includes('GET') ?? false)
const browseData = () => {
  if (resource.value && canBrowseData.value) navigateTo(`/resources/${resource.value.id}/data`)
}
const dataViewWizardOpen = ref(false)
// The wizard loads on first open, then stays mounted.
const dataViewWizardMounted = useOpenedOnce(dataViewWizardOpen)
const { refresh: refreshDataViews } = useAppsNavDataViews()

const dashboardWizardOpen = ref(false)
// The dashboard assistant, this table chosen (Dashboards.md §10.7) - loaded on first open.
const dashboardWizardMounted = useOpenedOnce(dashboardWizardOpen)
const { refresh: refreshDashboards } = useAppsNavDashboards()
async function onDashboardCreated(id: string) {
  await refreshDashboards()
  await navigateTo(`/dashboards/${id}`)
}

const quickDataViewOpen = ref(false)
const quickDataViewMounted = useOpenedOnce(quickDataViewOpen)
async function onDataViewCreated(dataview: DataView) {
  await refreshDataViews()
  await navigateTo(`/dataviews/${dataview.id}/settings`)
}

const isDropOpen = ref(false)
const dropCascade = ref(false)
const dropConfirmed = ref(false)
const dropping = ref(false)

function openDrop() {
  dropCascade.value = false
  dropConfirmed.value = false
  isDropOpen.value = true
}

async function confirmDrop() {
  if (!resource.value) return
  dropping.value = true
  try {
    const qs = dropCascade.value ? '?cascade=true' : ''
    await api.del(`/schema/${resource.value.schema}/tables/${resource.value.name}${qs}`)
    toast.add({ title: t('database.tableResourceDetail.deleted'), color: 'success' })
    isDropOpen.value = false
    // The shared registry and schema list DatabaseTree.vue reads - it's a
    // layout sibling, not a parent/child, so there's no prop/emit path to
    // it; the shared keys reach it (useResourcesList's convention).
    await Promise.all([refreshResourcesList(), refreshSchemasList()])
    router.back()
  } catch (err) {
    notifyError(err, t('database.tableResourceDetail.deleteError'))
  } finally {
    dropping.value = false
  }
}
</script>

<template>
  <NuxtPage v-if="route.path.endsWith('/data')" />
  <PageShell v-else>
    <template
      v-if="!error"
      #header
    >
      <PageHeader
        :title="resource?.name ?? ''"
        :description="resource?.description ?? undefined"
        :icon="resource ? RESOURCE_TYPE_STYLE[resource.type].icon : undefined"
      >
        <template #center>
          <UBadge
            v-for="method in resource?.exposedMethods ?? []"
            :key="method"
            :color="methodColor(method)"
            variant="subtle"
            size="xs"
          >
            {{ method }}
          </UBadge>
          <span
            v-if="!resource?.exposedMethods.length"
            class="text-xs text-muted"
          >
            {{ t('database.resourceDetail.notExposed') }}
          </span>
        </template>
      </PageHeader>
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('database.tableResourceDetail.loadError')"
      :description="errorMessage(error, t('database.resourceDetail.loadErrorDescription'))"
    />

    <template v-else>
      <UEmpty
        v-if="pending || !resource"
        loading
        variant="naked"
        size="sm"
      />

      <div
        v-else
        class="flex flex-1 min-h-0 flex-col overflow-y-auto"
      >
        <div class="mx-auto flex w-[95%] flex-col gap-8 pb-12 md:w-3/4">
          <!-- Group 1: Data -->
          <SettingsSection :title="t('database.resourceDetail.data')">
            <NotOwnedNote
              v-if="notOwned"
              kind="table"
              :owner="ownership!.owner"
            />

            <div>
              <p class="text-sm font-medium mb-1">
                {{ t('common.name') }}
              </p>
              <UInput
                :aria-label="t('common.name')"
                :model-value="resource.name"
                disabled
                class="w-full"
              />
              <p class="text-xs text-muted mt-1">
                {{ t('database.tableResourceDetail.renameHint') }}
              </p>
            </div>

            <div>
              <p class="text-sm font-medium mb-1">
                {{ t('common.description') }}
              </p>
              <UTextarea
                v-model="descriptionDraft"
                :aria-label="t('common.description')"
                :rows="2"
                class="w-full"
                :disabled="savingDescription"
                @blur="saveDescription"
              />
            </div>

            <div>
              <p class="text-sm font-medium mb-1">
                {{ t('database.resourceDetail.schema') }}
              </p>
              <UInput
                :aria-label="t('database.resourceDetail.schema')"
                :model-value="resource.schema"
                disabled
                class="w-full"
              />
            </div>
          </SettingsSection>

          <div class="flex flex-wrap gap-2">
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
            <!-- From a table to a screen in one step; More options opens the wizard. -->
            <UButton
              :label="t('database.resourceDetail.createDataView')"
              icon="i-lucide-layout-panel-left"
              color="primary"
              variant="solid"
              @click="quickDataViewOpen = true"
            />
            <UButton
              :label="t('database.resourceDetail.createDashboard')"
              icon="i-lucide-layout-dashboard"
              color="primary"
              variant="solid"
              @click="dashboardWizardOpen = true"
            />
          </div>

          <!-- Group 2: Columns -->
          <section>
            <ResourceColumns
              :resource="resource"
              :open-presentation="typeof route.query.presentation === 'string' ? route.query.presentation : undefined"
              @loaded="(detail: RelationDetail) => ownership = { owner: detail.owner, canAlter: detail.canAlter }"
            />
          </section>

          <!-- Group 3: Indexes -->
          <section>
            <ResourceIndexes :resource="resource" />
          </section>

          <!-- Group 5: Constraints -->
          <section>
            <ResourceConstraints :resource="resource" />
          </section>

          <!-- Group 6: DataViews -->
          <section>
            <ResourceDataViews :resource="resource" />
          </section>

          <!-- Group 7: Endpoints - last, deliberately: exposure is what
          you touch once you're done reviewing the table's real structure
          above, not the first thing this page leads with. -->
          <SettingsSection :title="t('database.resourceDetail.endpoints')">
            <i18n-t
              keypath="database.tableResourceDetail.endpointsIntro"
              tag="p"
              class="text-sm text-muted"
            >
              <template #name>
                <span class="font-medium text-default">{{ resource.schema }}.{{ resource.name }}</span>
              </template>
            </i18n-t>
            <div class="flex flex-col gap-2">
              <div
                v-for="m in APPLICABLE_METHODS[resource.type]"
                :key="m"
                class="flex items-center justify-between gap-3 border border-default rounded-lg px-3 py-2"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <UBadge
                    :color="methodColor(m)"
                    variant="subtle"
                    size="sm"
                  >
                    {{ m }}
                  </UBadge>
                  <span class="font-mono text-xs text-muted truncate">{{ endpointPath(m) }}</span>
                </div>
                <USwitch
                  :model-value="resource.exposedMethods.includes(m)"
                  :aria-label="t('database.resourceDetail.exposeMethod', { method: m })"
                  :loading="endpointsSaving === m"
                  @update:model-value="(v: boolean) => toggleEndpoint(m, v)"
                />
              </div>
              <ResourceIdempotencyKey
                :resource="resource"
                @update:resource="(next: Resource) => resource = next"
              />
            </div>
          </SettingsSection>

          <!-- Group 8: Auditing - beside Endpoints, how the Data API
          records what goes through it. -->
          <ResourceAuditing
            :key="resource.id"
            :resource="resource"
            @update:resource="(next: Resource) => resource = next"
          />

          <!-- Group 7: Danger zone - last of all, its own tinted panel
          rather than the shared h4-section pattern above, so it reads as
          a distinct, higher-stakes area. -->
          <section class="rounded-lg bg-error/10 p-5 flex flex-col gap-3">
            <div>
              <p class="font-semibold">
                {{ t('database.tableResourceDetail.deleteTitle') }}
              </p>
              <p class="text-sm text-muted mt-1">
                {{ t('database.resourceDetail.permanentlyDeletes', { name: `${resource.schema}.${resource.name}` }) }}
              </p>
            </div>
            <UButton
              :label="t('database.tableResourceDetail.deleteButton')"
              color="error"
              variant="soft"
              class="self-start"
              :disabled="notOwned"
              @click="openDrop"
            />
          </section>
        </div>
      </div>
    </template>

    <LazyQuickDataViewModal
      v-if="quickDataViewMounted && resource"
      v-model:open="quickDataViewOpen"
      :resource-id="resource.id"
      :table-name="resource.name"
      @more="dataViewWizardOpen = true"
    />
    <LazyDataViewWizardModal
      v-if="dataViewWizardMounted && resource"
      v-model:open="dataViewWizardOpen"
      :initial-resource-id="resource.id"
      @created="onDataViewCreated"
    />
    <LazyDashboardFromTableWizard
      v-if="dashboardWizardMounted && resource"
      v-model:open="dashboardWizardOpen"
      :initial-resource-id="resource.id"
      @created="onDashboardCreated"
    />

    <!-- Danger zone: drop table -->
    <UModal
      v-model:open="isDropOpen"
      :title="t('database.tableResourceDetail.deleteModalTitle')"
    >
      <template #body>
        <div
          v-if="resource"
          class="flex flex-col gap-4"
        >
          <i18n-t
            keypath="database.resourceDetail.dropBody"
            tag="p"
            class="text-sm text-muted"
          >
            <template #name>
              <span class="font-mono text-default">{{ resource.schema }}.{{ resource.name }}</span>
            </template>
          </i18n-t>
          <div class="flex items-center gap-2">
            <USwitch v-model="dropCascade" />
            <span class="text-sm">{{ t('database.resourceDetail.cascade') }}</span>
          </div>
          <div class="flex items-center justify-between gap-2 border-t border-default pt-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <UCheckbox v-model="dropConfirmed" />
              <span class="text-sm">{{ t('common.confirm') }}</span>
            </label>
            <div class="flex gap-2">
              <UButton
                :label="t('common.cancel')"
                color="neutral"
                variant="ghost"
                :disabled="dropping"
                @click="isDropOpen = false"
              />
              <UButton
                :label="t('common.delete')"
                color="error"
                :disabled="!dropConfirmed"
                :loading="dropping"
                @click="confirmDrop"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
