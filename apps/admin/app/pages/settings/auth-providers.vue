<script setup lang="ts">
import type { AuthProvider, AuthProviderType } from '~/types/auth-provider'
import type { SecretMetadata } from '~/types/secret'
import type { WizardStep } from '~/components/WizardModal.vue'
import type { KnownProviderDef } from '~/utils/known-auth-providers'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

const api = useAdminApi()
const rolesApi = useRolesApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const catalog = useCatalogText()

// A known provider's texts in the UI's language - a brand name stays as it is.
function providerLabel(def: KnownProviderDef) {
  return catalog(`settings.authProviders.known.${def.id}.label`, def.label)
}
function providerFieldText(def: KnownProviderDef, field: string, part: 'label' | 'description', english: string | undefined) {
  return catalog(`settings.authProviders.known.${def.id}.fields.${field}.${part}`, english)
}

const { data: providers, pending, error, refresh } = await useAsyncData(
  'auth-providers',
  () => api.get<AuthProvider[]>('/auth-providers').then(r => r.data),
  { default: () => [] }
)

const refreshing = ref(false)
async function refreshProviders() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

// Existing secret keys (for the client secret picker) and roles (for the
// default-role picker) - both fetched once and reused across create/edit,
// same as proxies.vue's secretKeys.
const { data: secretKeys, refresh: refreshSecretKeys } = await useAsyncData(
  'auth-providers-secret-keys',
  () => api.get<SecretMetadata[]>('/secrets').then(r => r.data.map(s => s.key)),
  { default: () => [] }
)
const { data: roles } = await useAsyncData(
  'auth-providers-roles',
  () => rolesApi.list(),
  { default: () => [] }
)
const roleOptions = computed(() => [
  { label: t('settings.authProviders.noRole'), value: null },
  ...(roles.value ?? []).map(r => ({ label: r.name, value: r.id }))
])

const search = ref('')
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  if (!term) return providers.value ?? []
  return (providers.value ?? []).filter(p =>
    p.name.toLowerCase().includes(term) || p.type.toLowerCase().includes(term)
  )
})

// The preset a stored provider came from (Google, Okta, ...) - only its
// base type is persisted, so the brand icon/label is matched back from it.
function presetOf(provider: AuthProvider) {
  return findKnownProvider(guessKnownProviderId(provider.type, provider.configuration.issuer))
}
function formatDay(iso: string) {
  return dates.date(iso, { year: 'numeric', month: 'short', day: 'numeric' })
}
function actionItems(provider: AuthProvider) {
  return [
    { label: t('common.edit'), icon: 'i-lucide-pencil', onSelect: () => openEdit(provider) },
    { label: provider.enabled ? t('settings.authProviders.disable') : t('settings.authProviders.enable'), icon: provider.enabled ? 'i-lucide-pause' : 'i-lucide-play', onSelect: () => toggleEnabled(provider) },
    { label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => openDrop([{ id: provider.id, name: provider.name }]) }
  ]
}

// --- "New provider" wizard - step 1 is a card grid of known providers
// (icon + name), step 2 collects only the fields that provider actually
// needs (nothing for Google/GitLab/Apple..., a tenant/domain for
// Microsoft/Okta/Auth0, a raw issuer for a fully custom OIDC provider),
// step 3 is credentials + access, same as the old flat form. Whatever gets
// picked still resolves to one of the three types the backend understands
// (baseType) - see ~/utils/known-auth-providers.ts. Editing an existing
// provider skips the wizard entirely: type is fixed once created, so there's
// nothing left to "pick". ---
const wizard = useTemplateRef('wizard')
const selectedProviderId = ref<string | null>(null)
const providerFieldValues = ref<Record<string, string>>({})
const selectedProviderDef = computed(() => findKnownProvider(selectedProviderId.value))
// True while draft.name still holds the auto-filled provider label rather
// than something the admin typed - lets re-picking a provider in step 1
// (after going Back) update the suggested name again, without ever
// clobbering a name the admin has actually edited.
const nameFromPreset = ref(false)

const wizardSteps = computed<WizardStep[]>(() => [
  { key: 'provider', title: t('settings.authProviders.steps.provider'), description: t('settings.authProviders.steps.providerDescription'), valid: !!selectedProviderId.value },
  { key: 'config', title: t('settings.authProviders.steps.config'), description: t('settings.authProviders.steps.configDescription'), valid: !!draft.value.name.trim() },
  { key: 'credentials', title: t('settings.authProviders.steps.credentials'), description: t('settings.authProviders.steps.credentialsDescription') }
])

function selectProvider(id: string) {
  const def = findKnownProvider(id)
  if (!def) return
  selectedProviderId.value = id
  providerFieldValues.value = {}
  draft.value.type = def.baseType
  draft.value.issuer = def.fixedIssuer ?? ''
  if (!draft.value.name.trim() || nameFromPreset.value) {
    draft.value.name = providerLabel(def)
    nameFromPreset.value = true
  }
  // The wizard reads validity from its props, which reach it on the next tick.
  void nextTick(() => wizard.value?.next())
}

/** Leaving Configuration builds the issuer from the provider's own fields. */
function beforeWizardNext(key: string): boolean {
  if (key !== 'config') return true
  const def = selectedProviderDef.value
  if (!def?.buildIssuer) return true
  const issuer = def.buildIssuer(providerFieldValues.value)
  if (!issuer) {
    toast.add({ title: t('settings.authProviders.fillField'), color: 'error' })
    return false
  }
  draft.value.issuer = issuer
  return true
}

// --- Selection ---
const rowSelection = ref<Record<string, boolean>>({})
const selectedProviders = computed(() => (providers.value ?? []).filter(p => rowSelection.value[p.id]))
const allSelected = computed<boolean | 'indeterminate'>(() => {
  const n = filtered.value.filter(p => rowSelection.value[p.id]).length
  if (n === 0) return false
  return n === filtered.value.length ? true : 'indeterminate'
})
function setSelected(ids: string[], value: boolean) {
  const changing = new Set(ids)
  rowSelection.value = Object.fromEntries([
    ...Object.entries(rowSelection.value).filter(([id]) => !changing.has(id)),
    ...(value ? ids.map(id => [id, true] as const) : [])
  ])
}

// --- Quick enable/disable - a switch on the card itself: a binary,
// instantly-reversible toggle doesn't need a confirmation step. ---
const toggling = ref<string | null>(null)
async function toggleEnabled(provider: AuthProvider) {
  toggling.value = provider.id
  try {
    await api.patch(`/auth-providers/${provider.id}`, { data: { enabled: !provider.enabled } })
    toast.add({ title: provider.enabled ? t('settings.authProviders.disabled') : t('settings.authProviders.enabled'), color: 'success' })
    await refresh()
  } catch (err) {
    notifyError(err, t('settings.authProviders.updateError'))
  } finally {
    toggling.value = null
  }
}

// --- Create / edit ---
interface DraftProvider {
  id: string | null
  type: AuthProviderType
  name: string
  enabled: boolean
  showOnSignIn: boolean
  clientId: string
  clientSecretKey: string
  issuer: string
  allowedRedirectUrls: string[]
  defaultRoleId: string | null
}
function emptyDraft(): DraftProvider {
  return {
    id: null,
    type: 'GOOGLE',
    name: '',
    enabled: true,
    showOnSignIn: false,
    clientId: '',
    clientSecretKey: '',
    issuer: '',
    allowedRedirectUrls: [],
    defaultRoleId: null
  }
}
const draft = ref<DraftProvider>(emptyDraft())
const isFormOpen = ref(false)
const saving = ref(false)
const redirectUri = ref<string | null>(null)
const loadingRedirectUri = ref(false)

const emptyState = computed(() => search.value.trim()
  ? { title: t('settings.authProviders.noMatch', { query: search.value.trim() }), actions: [{ label: t('settings.panel.clearSearch'), color: 'neutral' as const, variant: 'link' as const, onClick: () => { search.value = '' } }] }
  : {
      title: t('settings.authProviders.emptyTitle'),
      description: t('settings.authProviders.emptyDescription'),
      actions: [{ label: t('settings.authProviders.newProvider'), icon: 'i-lucide-plus', onClick: openCreate }]
    })
function openCreate() {
  draft.value = emptyDraft()
  selectedProviderId.value = null
  providerFieldValues.value = {}
  nameFromPreset.value = false
  redirectUri.value = null
  refreshSecretKeys()
  isFormOpen.value = true
}

async function openEdit(provider: AuthProvider) {
  draft.value = {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    enabled: provider.enabled,
    showOnSignIn: provider.showOnSignIn,
    clientId: provider.configuration.client_id,
    clientSecretKey: provider.configuration.client_secret_key,
    issuer: provider.configuration.issuer ?? '',
    allowedRedirectUrls: [...provider.configuration.allowed_redirect_urls],
    defaultRoleId: provider.configuration.default_role_id ?? null
  }
  redirectUri.value = null
  refreshSecretKeys()
  isFormOpen.value = true
  loadingRedirectUri.value = true
  try {
    const { data } = await api.get<{ redirectUri: string }>(`/auth-providers/${provider.id}/redirect-uri`)
    redirectUri.value = data.redirectUri
  } finally {
    loadingRedirectUri.value = false
  }
}

async function copyRedirectUri() {
  if (!redirectUri.value) return
  await navigator.clipboard.writeText(redirectUri.value)
  toast.add({ title: t('common.copied'), color: 'success' })
}

async function save() {
  if (!draft.value.name.trim()) {
    toast.add({ title: t('settings.authProviders.nameRequired'), color: 'error' })
    return
  }
  if (!draft.value.clientId.trim() || !draft.value.clientSecretKey) {
    toast.add({ title: t('settings.authProviders.clientRequired'), color: 'error' })
    return
  }
  // A provider shown on the sign-in page needs no URL of its own - the portal's callback is always allowed.
  if (draft.value.allowedRedirectUrls.length === 0 && !draft.value.showOnSignIn) {
    toast.add({ title: t('settings.authProviders.redirectRequired'), color: 'error' })
    return
  }
  if (draft.value.type === 'OIDC' && !draft.value.issuer.trim()) {
    toast.add({ title: t('settings.authProviders.issuerRequired'), color: 'error' })
    return
  }

  const configuration = {
    client_id: draft.value.clientId,
    client_secret_key: draft.value.clientSecretKey,
    allowed_redirect_urls: draft.value.allowedRedirectUrls,
    default_role_id: draft.value.defaultRoleId,
    ...(draft.value.type === 'OIDC' ? { issuer: draft.value.issuer } : {})
  }

  saving.value = true
  try {
    if (draft.value.id) {
      await api.patch(`/auth-providers/${draft.value.id}`, {
        data: { name: draft.value.name, enabled: draft.value.enabled, showOnSignIn: draft.value.showOnSignIn, configuration }
      })
    } else {
      await api.post('/auth-providers', {
        data: { type: draft.value.type, name: draft.value.name, enabled: draft.value.enabled, showOnSignIn: draft.value.showOnSignIn, configuration }
      })
    }
    toast.add({ title: draft.value.id ? t('settings.authProviders.updated') : t('settings.authProviders.created'), color: 'success' })
    isFormOpen.value = false
    await refresh()
  } catch (err) {
    notifyError(err, t('settings.authProviders.saveError'))
  } finally {
    saving.value = false
  }
}

// --- Delete ---
const dropTargets = ref<Array<{ id: string, name: string }>>([])
const isDeleteOpen = computed({
  get: () => dropTargets.value.length > 0,
  set: (open: boolean) => { if (!open) dropTargets.value = [] }
})
const dropConfirmed = ref(false)
const deleting = ref(false)
const deleteModalTitle = computed(() =>
  t('settings.authProviders.deleteTitle', dropTargets.value.length)
)

function openDrop(targets: Array<{ id: string, name: string }>) {
  dropConfirmed.value = false
  dropTargets.value = targets
}

async function confirmDrop() {
  const targets = dropTargets.value
  deleting.value = true
  let failures = 0
  for (const target of targets) {
    try {
      await api.del(`/auth-providers/${target.id}`)
    } catch {
      failures += 1
    }
  }
  deleting.value = false
  dropTargets.value = []
  rowSelection.value = {}
  if (draft.value.id && targets.some(target => target.id === draft.value.id)) isFormOpen.value = false
  await refresh()
  if (failures === 0) {
    toast.add({ title: t('settings.authProviders.deleted', targets.length), color: 'success' })
  } else {
    toast.add({
      title: t('settings.secrets.partiallyDeleted', { done: targets.length - failures, total: targets.length }),
      description: t('settings.authProviders.deleteFailures', { n: failures }),
      color: 'warning'
    })
  }
}
// Header: Refresh (PageHeader's "⋮" on a phone) and the bulk actions
// while rows are selected.
const headerActions = computed<HeaderAction[]>(() => [
  { label: t('settings.authProviders.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: refreshing.value, onSelect: refreshProviders }
])
const headerSelection = computed<HeaderSelection>(() => ({
  count: selectedProviders.value.length,
  actions: [{ label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => openDrop(selectedProviders.value) }],
  onClear: () => {
    rowSelection.value = {}
  }
}))
</script>

<template>
  <PageShell>
    <!-- Providers are a small, bounded set - a card list, no pager (see
    TokensTable.vue). Left = acts on the set, right = how you view it. -->
    <template #header>
      <PageHeader
        :title="t('settings.authProviders.title')"
        :description="t('settings.authProviders.description')"
        icon="i-lucide-fingerprint"
        :actions="headerActions"
        :selection="headerSelection"
      >
        <template #search>
          <HeaderSearch
            v-model="search"
            :placeholder="t('settings.authProviders.searchByNameOrType')"
            class="w-64"
          />
        </template>
        <UButton
          v-if="selectedProviders.length === 0"
          icon="i-lucide-plus"
          :label="t('settings.authProviders.newProvider')"
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
            :aria-label="t('settings.authProviders.selectAll')"
            @update:model-value="(v: boolean | 'indeterminate') => setSelected(filtered.map(p => p.id), v === true)"
          />
          <span class="flex-1 text-sm font-medium text-highlighted">{{ t('settings.authProviders.provider') }}</span>
          <span class="text-xs text-muted">{{ t('common.enabled') }}</span>
          <span class="w-8" />
        </div>
        <div class="flex flex-col divide-y divide-default">
          <div
            v-for="provider in filtered"
            :key="provider.id"
            role="button"
            :aria-label="provider.name"
            tabindex="0"
            class="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-elevated/40"
            @click="openEdit(provider)"
            @keydown.enter.space.self.prevent="openEdit(provider)"
          >
            <UCheckbox
              :model-value="!!rowSelection[provider.id]"
              :aria-label="t('settings.secrets.select', { key: provider.name })"
              @click.stop
              @update:model-value="(v: boolean | 'indeterminate') => setSelected([provider.id], v === true)"
            />
            <UIcon
              :name="presetOf(provider)?.icon ?? 'i-lucide-shield-check'"
              class="size-6 shrink-0"
              :class="provider.enabled ? 'text-highlighted' : 'text-dimmed'"
            />
            <div
              class="flex min-w-0 flex-1 flex-col gap-0.5"
              :class="provider.enabled ? undefined : 'opacity-60'"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-highlighted">{{ provider.name }}</span>
                <UBadge
                  v-if="(presetOf(provider) ? providerLabel(presetOf(provider)!) : provider.type) !== provider.name"
                  :label="presetOf(provider) ? providerLabel(presetOf(provider)!) : provider.type"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                />
              </div>
              <p class="truncate text-xs text-muted">
                <span
                  v-if="provider.configuration.issuer"
                  class="font-mono"
                >{{ provider.configuration.issuer }} · </span>
                {{ t('settings.authProviders.redirectCount', provider.configuration.allowed_redirect_urls.length) }}
                · {{ t('settings.authProviders.updatedOn', { date: formatDay(provider.updatedAt) }) }}
              </p>
            </div>
            <USwitch
              :model-value="provider.enabled"
              :loading="toggling === provider.id"
              :aria-label="provider.enabled ? t('settings.authProviders.disableNamed', { name: provider.name }) : t('settings.authProviders.enableNamed', { name: provider.name })"
              @click.stop
              @update:model-value="toggleEnabled(provider)"
            />
            <UDropdownMenu
              :items="actionItems(provider)"
              :content="{ align: 'end' }"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                color="neutral"
                variant="ghost"
                size="sm"
                :aria-label="t('settings.secrets.actionsFor', { key: provider.name })"
                @click.stop
              />
            </UDropdownMenu>
          </div>
        </div>
      </div>

      <UEmpty
        v-else-if="!pending"
        icon="i-lucide-fingerprint"
        v-bind="emptyState"
      />
    </div>

    <template #footer>
      <span class="text-sm text-muted">
        {{ t('settings.authProviders.count', filtered.length) }}<template v-if="filtered.length !== (providers?.length ?? 0)">{{ t('settings.secrets.countOf', { total: providers?.length ?? 0 }) }}</template>
        · {{ t('settings.authProviders.enabledCount', { n: (providers ?? []).filter(p => p.enabled).length }) }}
      </span>
    </template>

    <!-- Create - 3-step WizardModal: pick provider, its specific fields, credentials. -->
    <WizardModal
      v-if="!draft.id"
      ref="wizard"
      v-model:open="isFormOpen"
      :title="t('settings.authProviders.newProvider')"
      :steps="wizardSteps"
      :submit-label="t('common.save')"
      :submitting="saving"
      width="max-w-2xl"
      :before-next="beforeWizardNext"
      @submit="save"
    >
      <template #provider>
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="p in knownAuthProviders"
            :key="p.id"
            type="button"
            class="flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors cursor-pointer"
            :class="p.id === selectedProviderId ? 'border-primary bg-primary/5' : 'border-default hover:border-primary hover:bg-elevated'"
            @click="selectProvider(p.id)"
          >
            <UIcon
              :name="p.icon"
              class="size-8"
            />
            <span class="text-xs text-center">{{ providerLabel(p) }}</span>
          </button>
        </div>
      </template>

      <template #config>
        <UFormField :label="t('common.name')">
          <UInput
            v-model="draft.name"
            class="w-full"
            @update:model-value="nameFromPreset = false"
          />
        </UFormField>

        <UFormField
          v-for="field in selectedProviderDef?.fields ?? []"
          :key="field.key"
          :label="providerFieldText(selectedProviderDef!, field.key, 'label', field.label)"
          :description="providerFieldText(selectedProviderDef!, field.key, 'description', field.description)"
        >
          <UInput
            v-model="providerFieldValues[field.key]"
            class="w-full font-mono text-xs"
          />
        </UFormField>

        <p
          v-if="!selectedProviderDef?.fields?.length"
          class="text-sm text-muted"
        >
          {{ t('settings.authProviders.noExtraConfig', { provider: selectedProviderDef ? providerLabel(selectedProviderDef) : '' }) }}
        </p>
      </template>

      <template #credentials>
        <UFormField :label="t('settings.authProviders.clientId')">
          <UInput
            v-model="draft.clientId"
            class="w-full font-mono text-xs"
          />
        </UFormField>

        <UFormField
          :label="t('settings.authProviders.clientSecret')"
          :description="t('settings.authProviders.clientSecretDescription')"
        >
          <USelect
            v-model="draft.clientSecretKey"
            :items="secretKeys ?? []"
            class="w-full"
          />
          <p
            v-if="(secretKeys ?? []).length === 0"
            class="text-xs text-warning mt-1"
          >
            {{ t('settings.authProviders.noSecrets') }}
          </p>
        </UFormField>

        <UFormField
          :label="t('settings.authProviders.allowedRedirects')"
          :description="t('settings.authProviders.allowedRedirectsDescription')"
        >
          <UInputTags
            v-model="draft.allowedRedirectUrls"
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="t('settings.authProviders.defaultRole')"
          :description="t('settings.authProviders.defaultRoleDescription')"
        >
          <USelect
            v-model="draft.defaultRoleId"
            :items="roleOptions"
            value-key="value"
            class="w-full"
          />
        </UFormField>

        <div class="flex items-center gap-2">
          <USwitch v-model="draft.enabled" />
          <span class="text-sm">{{ t('common.enabled') }}</span>
        </div>
        <USwitch
          v-model="draft.showOnSignIn"
          :label="t('settings.authProviders.showOnSignIn')"
          :description="t('settings.authProviders.showOnSignInDescription')"
        />
      </template>
    </WizardModal>

    <!-- Edit - flat form, type is fixed once created so there's no provider to pick -->
    <UModal
      v-else
      v-model:open="isFormOpen"
      :title="t('settings.authProviders.editProvider')"
      :ui="{ content: 'max-w-lg' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField :label="t('common.name')">
            <UInput
              v-model="draft.name"
              class="w-full"
            />
          </UFormField>

          <UFormField
            v-if="draft.type === 'OIDC'"
            :label="t('settings.authProviders.issuer')"
            :description="t('settings.authProviders.issuerDescription', { issuer: '{issuer}' })"
          >
            <UInput
              v-model="draft.issuer"
              class="w-full font-mono text-xs"
            />
          </UFormField>

          <UFormField :label="t('settings.authProviders.clientId')">
            <UInput
              v-model="draft.clientId"
              class="w-full font-mono text-xs"
            />
          </UFormField>

          <UFormField
            :label="t('settings.authProviders.clientSecret')"
            :description="t('settings.authProviders.clientSecretDescription')"
          >
            <USelect
              v-model="draft.clientSecretKey"
              :items="secretKeys ?? []"
              class="w-full"
            />
            <p
              v-if="(secretKeys ?? []).length === 0"
              class="text-xs text-warning mt-1"
            >
              {{ t('settings.authProviders.noSecrets') }}
            </p>
          </UFormField>

          <UFormField
            :label="t('settings.authProviders.allowedRedirects')"
            :description="t('settings.authProviders.allowedRedirectsDescription')"
          >
            <UInputTags
              v-model="draft.allowedRedirectUrls"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="t('settings.authProviders.defaultRole')"
            :description="t('settings.authProviders.defaultRoleDescription')"
          >
            <USelect
              v-model="draft.defaultRoleId"
              :items="roleOptions"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <div class="flex items-center gap-2">
            <USwitch v-model="draft.enabled" />
            <span class="text-sm">{{ t('common.enabled') }}</span>
          </div>
          <USwitch
            v-model="draft.showOnSignIn"
            :label="t('settings.authProviders.showOnSignIn')"
            :description="t('settings.authProviders.showOnSignInDescription')"
          />

          <UFormField
            :label="t('settings.authProviders.redirectUri')"
            :description="t('settings.authProviders.redirectUriDescription')"
          >
            <UInput
              :model-value="loadingRedirectUri ? t('common.loading') : (redirectUri ?? '')"
              readonly
              class="w-full"
              :ui="{ base: 'font-mono text-xs pr-9' }"
            >
              <template #trailing>
                <UTooltip :text="t('common.copy')">
                  <UButton
                    icon="i-lucide-copy"
                    color="neutral"
                    variant="link"
                    size="sm"
                    :padded="false"
                    :disabled="!redirectUri"
                    :aria-label="t('settings.authProviders.copyRedirectUri')"
                    @click="copyRedirectUri"
                  />
                </UTooltip>
              </template>
            </UInput>
          </UFormField>

          <UButton
            :label="t('common.delete')"
            color="error"
            variant="outline"
            class="self-start"
            @click="openDrop([{ id: draft.id!, name: draft.name }])"
          />
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

    <!-- Delete -->
    <UModal
      v-model:open="isDeleteOpen"
      :title="deleteModalTitle"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            {{ t('settings.authProviders.deleteBody') }}
          </p>
          <ul class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-default rounded-lg p-2">
            <li
              v-for="p in dropTargets"
              :key="p.id"
              class="text-sm truncate"
            >
              {{ p.name }}
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
