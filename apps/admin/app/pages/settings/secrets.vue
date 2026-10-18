<script setup lang="ts">
import { DEFAULT_SECRET_SIZE, generateSecret, SECRET_KINDS, SECRET_SIZES, secretLength, type SecretKind } from '~/utils/generate-secret'
import type { SecretMetadata } from '~/types/secret'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const { data: secrets, pending, error, refresh } = await useAsyncData(
  'secrets',
  () => api.get<SecretMetadata[]>('/secrets').then(r => r.data),
  { default: () => [] }
)

const refreshing = ref(false)
async function refreshSecrets() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

const search = ref('')
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  if (!term) return secrets.value ?? []
  return (secrets.value ?? []).filter(s => s.key.toLowerCase().includes(term))
})

// --- Selection - the header's left zone switches from "New secret" to
// bulk delete once something's checked. Keyed by key (secrets have no
// separate id).
const rowSelection = ref<Record<string, boolean>>({})
const selectedSecrets = computed(() => (secrets.value ?? []).filter(s => rowSelection.value[s.key]))
const allSelected = computed<boolean | 'indeterminate'>(() => {
  const n = filtered.value.filter(s => rowSelection.value[s.key]).length
  if (n === 0) return false
  return n === filtered.value.length ? true : 'indeterminate'
})
function setSelected(keys: string[], value: boolean) {
  const changing = new Set(keys)
  rowSelection.value = Object.fromEntries([
    ...Object.entries(rowSelection.value).filter(([key]) => !changing.has(key)),
    ...(value ? keys.map(key => [key, true] as const) : [])
  ])
}

function formatDay(iso: string) {
  return dates.date(iso, { year: 'numeric', month: 'short', day: 'numeric' })
}

// --- Create / replace ---
const isFormOpen = ref(false)
const saving = ref(false)
const draftKey = ref('')
const draftValue = ref('')
const showValue = ref(false)
const editingExisting = ref(false)

// --- Generate a value: kind and size in a popover; the last kind chosen
// is remembered in this browser. A generated value shows at once, with
// Copy - once saved it can never be read back. ---
const generatorOpen = ref(false)
const GENERATOR_STORAGE_KEY = 'totalbase.secrets.generator'
function readGeneratorChoice(): { kind: SecretKind, size: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(GENERATOR_STORAGE_KEY) ?? 'null')
    if (saved && SECRET_KINDS.includes(saved.kind) && SECRET_SIZES.includes(saved.size)) return saved
  } catch { /* storage unavailable - the defaults */ }
  return { kind: 'BASE64URL', size: DEFAULT_SECRET_SIZE }
}
const generatorKind = ref<SecretKind>('BASE64URL')
const generatorSize = ref<number>(DEFAULT_SECRET_SIZE)
onMounted(() => {
  const choice = readGeneratorChoice()
  generatorKind.value = choice.kind
  generatorSize.value = choice.size
})
const kindItems = computed(() => SECRET_KINDS.map(kind => ({ label: t(`settings.secrets.generator.kinds.${kind}`), value: kind })))
const sizeItems = computed(() => SECRET_SIZES.map(size => ({
  label: generatorKind.value === 'ALPHANUMERIC' ? t('settings.secrets.generator.characters', { n: size }) : t('settings.secrets.generator.bytes', { n: size }),
  value: size
})))
const generatorHint = computed(() => t('settings.secrets.generator.length', { n: secretLength(generatorKind.value, generatorSize.value) }))
/** The value in the field is the one just generated - not yet copied by hand or edited. */
const generatedValue = ref<string | null>(null)
const justGenerated = computed(() => generatedValue.value !== null && generatedValue.value === draftValue.value)
function generate() {
  const value = generateSecret(generatorKind.value, generatorSize.value)
  draftValue.value = value
  generatedValue.value = value
  showValue.value = true
  generatorOpen.value = false
  try {
    localStorage.setItem(GENERATOR_STORAGE_KEY, JSON.stringify({ kind: generatorKind.value, size: generatorSize.value }))
  } catch { /* storage unavailable - not remembered */ }
}
async function copyValue() {
  try {
    await navigator.clipboard.writeText(draftValue.value)
    toast.add({ title: t('settings.secrets.generator.copied'), color: 'success' })
  } catch {
    toast.add({ title: t('settings.secrets.generator.copyFailed'), color: 'error' })
  }
}

const emptyState = computed(() => search.value.trim()
  ? { title: t('settings.secrets.noMatch', { query: search.value.trim() }), actions: [{ label: t('settings.panel.clearSearch'), color: 'neutral' as const, variant: 'link' as const, onClick: () => { search.value = '' } }] }
  : {
      title: t('settings.secrets.emptyTitle'),
      description: t('settings.secrets.emptyDescription'),
      actions: [{ label: t('settings.secrets.newSecret'), icon: 'i-lucide-plus', onClick: openCreate }]
    })
function openCreate() {
  draftKey.value = ''
  draftValue.value = ''
  generatedValue.value = null
  showValue.value = false
  editingExisting.value = false
  isFormOpen.value = true
}
function openReplace(secret: SecretMetadata) {
  draftKey.value = secret.key
  draftValue.value = ''
  generatedValue.value = null
  showValue.value = false
  editingExisting.value = true
  isFormOpen.value = true
}

async function save() {
  if (!draftKey.value.trim() || !draftValue.value) {
    toast.add({ title: t('settings.secrets.keyValueRequired'), color: 'error' })
    return
  }
  saving.value = true
  try {
    await api.put(`/secrets/${encodeURIComponent(draftKey.value)}`, { data: { value: draftValue.value } })
    toast.add({ title: editingExisting.value ? t('settings.secrets.replaced') : t('settings.secrets.created'), color: 'success' })
    isFormOpen.value = false
    await refresh()
  } catch (err) {
    notifyError(err, t('settings.secrets.saveError'))
  } finally {
    saving.value = false
  }
}

function actionItems(secret: SecretMetadata) {
  return [
    { label: t('settings.secrets.replace'), icon: 'i-lucide-refresh-cw', onSelect: () => openReplace(secret) },
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => openDrop([secret]) }
  ]
}

// --- Delete - one row's action and the toolbar's bulk Delete both land
// here (openDrop takes a list either way; a single row is just a
// one-element list) - same shape as files.vue/templates.vue's delete
// flow. ---
const dropTargets = ref<SecretMetadata[]>([])
const isDeleteOpen = computed({
  get: () => dropTargets.value.length > 0,
  set: (open: boolean) => { if (!open) dropTargets.value = [] }
})
const dropConfirmed = ref(false)
const deleting = ref(false)
const deleteModalTitle = computed(() =>
  t('settings.secrets.deleteTitle', dropTargets.value.length)
)

function openDrop(targets: SecretMetadata[]) {
  dropConfirmed.value = false
  dropTargets.value = targets
}

async function confirmDrop() {
  const targets = dropTargets.value
  deleting.value = true
  let failures = 0
  for (const target of targets) {
    try {
      await api.del(`/secrets/${encodeURIComponent(target.key)}`)
    } catch {
      failures += 1
    }
  }
  deleting.value = false
  dropTargets.value = []
  rowSelection.value = {}
  await refresh()
  if (failures === 0) {
    toast.add({ title: t('settings.secrets.deleted', targets.length), color: 'success' })
  } else {
    toast.add({
      title: t('settings.secrets.partiallyDeleted', { done: targets.length - failures, total: targets.length }),
      description: t('settings.secrets.deleteFailures', { n: failures }),
      color: 'warning'
    })
  }
}
// Header: Refresh (PageHeader's "⋮" on a phone) and the bulk actions
// while rows are selected.
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('settings.secrets.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing.value, onSelect: refreshSecrets }
])
const headerSelection = computed<HeaderSelection>(() => ({
  count: selectedSecrets.value.length,
  actions: [{ label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => openDrop(selectedSecrets.value) }],
  onClear: () => {
    rowSelection.value = {}
  }
}))
</script>

<template>
  <PageShell>
    <!-- Secrets are a small, bounded set - a card list, no pager (see
    TokensTable.vue). Left = acts on the set (new / bulk delete once
    something's checked), right = how you're viewing it. -->
    <template #header>
      <PageHeader
        :title="t('settings.secrets.title')"
        :description="t('settings.secrets.description')"
        icon="i-lucide-lock-keyhole"
        :actions="headerActions"
        :selection="headerSelection"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('settings.secrets.searchByKey')"
            class="w-64"
          />
        </template>
        <UButton
          v-if="selectedSecrets.length === 0"
          icon="i-lucide-plus"
          :label="t('settings.secrets.newSecret')"
          @click="openCreate"
        />
      </PageHeader>
    </template>

    <div class="flex flex-col gap-4">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :title="error.message"
      />

      <div
        v-if="filtered.length"
        class="overflow-hidden rounded-lg border border-default bg-default"
      >
        <div class="flex items-center gap-3 border-b border-default bg-elevated/50 px-4 py-2.5">
          <UCheckbox
            :model-value="allSelected"
            :aria-label="t('settings.secrets.selectAll')"
            @update:model-value="(v: boolean | 'indeterminate') => setSelected(filtered.map(s => s.key), v === true)"
          />
          <span class="flex-1 text-sm font-medium text-highlighted">{{ t('settings.secrets.key') }}</span>
        </div>
        <div class="flex flex-col divide-y divide-default">
          <div
            v-for="secret in filtered"
            :key="secret.key"
            class="flex items-center gap-3 px-4 py-3"
          >
            <UCheckbox
              :model-value="!!rowSelection[secret.key]"
              :aria-label="t('settings.secrets.select', { key: secret.key })"
              @update:model-value="(v: boolean | 'indeterminate') => setSelected([secret.key], v === true)"
            />
            <UIcon
              name="i-lucide-key-square"
              class="size-5 shrink-0 text-muted"
            />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="truncate font-mono text-sm font-medium text-highlighted">{{ secret.key }}</span>
              <span class="text-xs text-muted">
                {{ t('settings.secrets.dates', { updated: formatDay(secret.updatedAt), created: formatDay(secret.createdAt) }) }}
              </span>
            </div>
            <UDropdownMenu
              :items="actionItems(secret)"
              :content="{ align: 'end' }"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                color="neutral"
                variant="ghost"
                size="sm"
                :aria-label="t('settings.secrets.actionsFor', { key: secret.key })"
              />
            </UDropdownMenu>
          </div>
        </div>
      </div>

      <UEmpty
        v-else-if="!pending"
        icon="i-lucide-lock-keyhole"
        v-bind="emptyState"
      />
    </div>

    <template #footer>
      <span class="text-sm text-muted">
        {{ t('settings.secrets.count', filtered.length) }}<template v-if="filtered.length !== (secrets?.length ?? 0)">{{ t('settings.secrets.countOf', { total: secrets?.length ?? 0 }) }}</template>
      </span>
    </template>

    <!-- Create/replace -->
    <UModal
      v-model:open="isFormOpen"
      :title="editingExisting ? t('settings.secrets.replaceTitle', { key: draftKey }) : t('settings.secrets.newSecret')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            v-if="!editingExisting"
            :label="t('settings.secrets.key')"
            :description="t('settings.secrets.keyDescription')"
          >
            <UInput
              v-model="draftKey"
              autocomplete="off"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            :label="t('common.value')"
            :description="justGenerated ? t('settings.secrets.generator.copyNow') : t('settings.secrets.valueDescription')"
          >
            <UInput
              v-model="draftValue"
              :type="showValue ? 'text' : 'password'"
              autocomplete="new-password"
              class="w-full"
              :class="showValue ? 'font-mono' : undefined"
              :ui="{ base: draftValue ? 'pr-24' : 'pr-16' }"
            >
              <template #trailing>
                <UTooltip
                  v-if="draftValue"
                  :text="t('common.copy')"
                >
                  <UButton
                    icon="i-lucide-copy"
                    :aria-label="t('settings.secrets.generator.copyValue')"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    class="mr-1"
                    @click="copyValue"
                  />
                </UTooltip>
                <UPopover v-model:open="generatorOpen">
                  <UTooltip :text="t('settings.secrets.generator.title')">
                    <UButton
                      icon="i-lucide-wand-sparkles"
                      :aria-label="t('settings.secrets.generator.title')"
                      color="neutral"
                      variant="link"
                      size="sm"
                      :padded="false"
                      class="mr-1"
                    />
                  </UTooltip>
                  <template #content>
                    <div class="flex w-72 flex-col gap-3 p-4">
                      <p class="text-sm font-medium">
                        {{ t('settings.secrets.generator.title') }}
                      </p>
                      <UFormField :label="t('settings.secrets.generator.kind')">
                        <URadioGroup
                          v-model="generatorKind"
                          :items="kindItems"
                        />
                      </UFormField>
                      <UFormField
                        v-if="generatorKind !== 'UUID'"
                        :label="t('settings.secrets.generator.size')"
                        :description="generatorHint"
                      >
                        <USelect
                          v-model="generatorSize"
                          :items="sizeItems"
                          class="w-full"
                        />
                      </UFormField>
                      <div class="flex justify-end">
                        <UButton
                          :label="t('settings.secrets.generator.generate')"
                          icon="i-lucide-wand-sparkles"
                          @click="generate"
                        />
                      </div>
                    </div>
                  </template>
                </UPopover>
                <UTooltip :text="showValue ? t('settings.secrets.hideValue') : t('settings.secrets.showValue')">
                  <UButton
                    :icon="showValue ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="showValue ? t('settings.secrets.hideValue') : t('settings.secrets.showValue')"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    @click="showValue = !showValue"
                  />
                </UTooltip>
              </template>
            </UInput>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="isFormOpen = false"
          />
          <UButton
            :label="t('common.save')"
            :loading="saving"
            @click="save"
          />
        </div>
      </template>
    </UModal>

    <!-- Delete - one row's action and the toolbar's bulk Delete both land
    here (openDrop takes a list either way; a single row is just a
    one-element list). -->
    <UModal
      v-model:open="isDeleteOpen"
      :title="deleteModalTitle"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            {{ t('settings.secrets.deleteBody') }}
          </p>
          <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-default rounded-lg p-2">
            <li
              v-for="s in dropTargets"
              :key="s.key"
              class="text-sm font-mono truncate"
            >
              {{ s.key }}
            </li>
          </ul>
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
                :disabled="deleting"
                @click="dropTargets = []"
              />
              <UButton
                :label="t('common.delete')"
                color="error"
                :disabled="!dropConfirmed"
                :loading="deleting"
                @click="confirmDrop"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
