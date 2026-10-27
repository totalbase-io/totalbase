<script setup lang="ts">
import type { DataApiMethod, FunctionClass, Resource } from '~/types/resource'
import { APPLICABLE_METHODS } from '~/types/resource'
import type { TableColumn } from '@nuxt/ui'
import type { FunctionDetail, FunctionParameter } from '~/types/schema'
import { useApiErrorMessage } from '~/utils/api-error-message'

const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()

const PARAMETER_COLUMNS = computed<TableColumn<FunctionParameter>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { accessorKey: 'dataType', header: t('common.type') },
  { id: 'required', header: t('common.required') }
])

const route = useRoute()
const router = useRouter()
const api = useAdminApi()
const resourcesApi = useResourcesApi()
const toast = useToast()
const resourceId = computed(() => route.params.id as string)

const { data: resource, pending, error } = await useAsyncData(
  () => `function-detail-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)

const { data: detail, pending: detailPending, error: detailError } = await useAsyncData(
  () => `function-definition-${resourceId.value}`,
  () => api.get<FunctionDetail>(`/catalog/function/${resourceId.value}`).then(r => r.data),
  { watch: [resourceId] }
)

const descriptionDraft = ref(resource.value?.description ?? '')
watch(() => resource.value?.id, () => {
  descriptionDraft.value = resource.value?.description ?? ''
})
const savingDescription = ref(false)

async function saveDescription() {
  if (!resource.value) return
  const next = descriptionDraft.value.trim() === '' ? null : descriptionDraft.value.trim()
  if (next === resource.value.description) return
  savingDescription.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${resource.value.id}`, { data: { description: next } })
    resource.value = data
  } catch (err) {
    notifyError(err, t('database.resourceDetail.descriptionUpdateError'))
  } finally {
    savingDescription.value = false
  }
}

// --- Function class (TotalBase's own metadata, autosaved like the
// description and the endpoints) ---
const FUNCTION_CLASS_OPTIONS: FunctionClass[] = ['UNCLASSIFIED', 'QUERY', 'ACTION']
const savingClass = ref(false)

async function saveFunctionClass(functionClass: FunctionClass) {
  if (!resource.value || functionClass === (resource.value.functionClass ?? 'UNCLASSIFIED')) return
  savingClass.value = true
  try {
    const { data } = await api.patch<Resource>(`/resources/${resource.value.id}`, { data: { functionClass } })
    resource.value = data
    toast.add({ title: t('database.functionDetail.classUpdated'), color: 'success' })
  } catch (err) {
    notifyError(err, t('database.functionDetail.classUpdateError'))
  } finally {
    savingClass.value = false
  }
}

const endpointsSaving = ref<DataApiMethod | null>(null)
function endpointPath(method: DataApiMethod): string {
  const base = `/api/${resource.value!.schema}/function/${resource.value!.name}`
  return method === 'GET' || method === 'POST' ? base : `${base}/{pk}`
}
function methodColor(method: DataApiMethod) {
  return { GET: 'info', POST: 'success', PATCH: 'warning', DELETE: 'error', REALTIME: 'neutral' }[method] as 'info' | 'success' | 'warning' | 'error' | 'neutral'
}

async function toggleEndpoint(method: DataApiMethod, enabled: boolean) {
  if (!resource.value) return
  const next = enabled
    ? [...resource.value.exposedMethods, method]
    : resource.value.exposedMethods.filter(m => m !== method)
  endpointsSaving.value = method
  try {
    const { data } = await api.patch<Resource>(`/resources/${resource.value.id}`, { data: { exposedMethods: next } })
    resource.value = data
    await refreshResourcesList()
  } catch (err) {
    notifyError(err, t('database.resourceDetail.endpointsUpdateError'))
  } finally {
    endpointsSaving.value = null
  }
}

const sqlConsoleOpen = ref(false)
const sqlConsoleInitialSql = ref('')
const sqlConsoleEditingLabel = ref('')
const loadingDefinition = ref(false)

async function openSqlConsole() {
  if (!resource.value) return
  loadingDefinition.value = true
  try {
    const { data } = await api.get<{ ddl: string }>(`/catalog/function/${resource.value.id}/ddl`)
    sqlConsoleInitialSql.value = data.ddl
    sqlConsoleEditingLabel.value = `${resource.value.schema}.${resource.value.name}`
    sqlConsoleOpen.value = true
  } catch (err) {
    notifyError(err, t('database.functionResourceDetail.definitionLoadError'))
  } finally {
    loadingDefinition.value = false
  }
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
    await api.del(`/schema/functions/${resource.value.id}${qs}`)
    await refreshResourcesList()
    toast.add({ title: t('database.functionResourceDetail.deleted'), color: 'success' })
    isDropOpen.value = false
    router.back()
  } catch (err) {
    notifyError(err, t('database.functionResourceDetail.deleteError'))
  } finally {
    dropping.value = false
  }
}
</script>

<template>
  <PageShell>
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
      :title="t('database.functionResourceDetail.loadError')"
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
          <SettingsSection :title="t('database.resourceDetail.data')">
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
                {{ t('database.functionResourceDetail.renameHint') }}
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
            <UFormField
              :label="t('database.functionDetail.functionClass')"
              :description="t('database.functionResourceDetail.classDescription')"
            >
              <USelect
                :model-value="resource.functionClass ?? 'UNCLASSIFIED'"
                :items="FUNCTION_CLASS_OPTIONS"
                :loading="savingClass"
                class="w-full"
                @update:model-value="(value: FunctionClass) => saveFunctionClass(value)"
              />
            </UFormField>
          </SettingsSection>

          <div>
            <UButton
              :label="t('database.functionResourceDetail.editFunction')"
              icon="i-lucide-square-terminal"
              color="primary"
              variant="solid"
              :loading="loadingDefinition"
              @click="openSqlConsole"
            />
          </div>

          <SettingsSection :title="t('database.functionDetail.parameters')">
            <template #actions>
              <UBadge
                v-if="detail"
                :color="detail.returnsRows ? 'success' : 'neutral'"
                variant="subtle"
                size="sm"
              >
                {{ detail.returnsRows ? t('database.functionResourceDetail.returnsRows') : t('database.functionResourceDetail.scalarReturn') }}
              </UBadge>
            </template>
            <UAlert
              v-if="detailError"
              color="error"
              variant="subtle"
              :title="detailError.message"
            />
            <UEmpty
              v-else-if="detailPending"
              loading
              variant="naked"
              size="sm"
            />
            <UTable
              v-else-if="detail?.parameters.length"
              sticky
              :data="detail.parameters"
              :columns="PARAMETER_COLUMNS"
            >
              <template #name-cell="{ row }">
                <span class="font-medium text-highlighted">{{ row.original.name }}</span>
              </template>
              <template #dataType-cell="{ row }">
                <span class="font-mono text-xs">{{ row.original.dataType }}</span>
              </template>
              <template #required-cell="{ row }">
                {{ row.original.hasDefault ? t('common.no') : t('common.yes') }}
              </template>
            </UTable>
            <p
              v-else
              class="text-sm text-muted"
            >
              {{ t('database.functionResourceDetail.noParameters') }}
            </p>
          </SettingsSection>

          <SettingsSection :title="t('database.resourceDetail.endpoints')">
            <i18n-t
              keypath="database.resourceDetail.endpointsIntro"
              tag="p"
              class="text-sm text-muted"
            >
              <template #name>
                <span class="font-medium text-default">{{ resource.schema }}.{{ resource.name }}</span>
              </template>
            </i18n-t>
            <div class="flex flex-col gap-2">
              <div
                v-for="method in APPLICABLE_METHODS[resource.type]"
                :key="method"
                class="flex items-center justify-between gap-3 border border-default rounded-lg px-3 py-2"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <UBadge
                    :color="methodColor(method)"
                    variant="subtle"
                    size="sm"
                  >
                    {{ method }}
                  </UBadge>
                  <span class="font-mono text-xs text-muted truncate">{{ endpointPath(method) }}</span>
                </div>
                <USwitch
                  :model-value="resource.exposedMethods.includes(method)"
                  :aria-label="t('database.resourceDetail.exposeMethod', { method })"
                  :loading="endpointsSaving === method"
                  @update:model-value="(value: boolean) => toggleEndpoint(method, value)"
                />
              </div>
              <ResourceIdempotencyKey
                :resource="resource"
                @update:resource="(next: Resource) => resource = next"
              />
            </div>
          </SettingsSection>

          <ResourceAuditing
            :key="resource.id"
            :resource="resource"
            @update:resource="(next: Resource) => resource = next"
          />

          <section class="rounded-lg bg-error/10 p-5 flex flex-col gap-3">
            <div>
              <p class="font-semibold">
                {{ t('database.functionResourceDetail.deleteTitle') }}
              </p>
              <p class="text-sm text-muted mt-1">
                {{ t('database.resourceDetail.permanentlyDeletes', { name: `${resource.schema}.${resource.name}` }) }}
              </p>
            </div>
            <NotOwnedNote
              v-if="detail?.canAlter === false"
              kind="function"
              :owner="detail.owner"
            />
            <UButton
              :label="t('database.functionResourceDetail.deleteButton')"
              color="error"
              variant="soft"
              class="self-start"
              :disabled="detail?.canAlter === false"
              @click="openDrop"
            />
          </section>
        </div>
      </div>
    </template>

    <SqlConsoleDrawer
      v-model:open="sqlConsoleOpen"
      mode="edit"
      :initial-sql="sqlConsoleInitialSql"
      :editing-label="sqlConsoleEditingLabel"
    />

    <UModal
      v-model:open="isDropOpen"
      :title="t('database.functionResourceDetail.deleteModalTitle')"
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
