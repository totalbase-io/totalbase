<script setup lang="ts">
import { apiHeaders } from '~/utils/api-headers'

// GET /admin/api/openapi is the one Admin API endpoint that does NOT
// use the {data: ...} envelope — it returns the raw OpenAPI document
// directly, since that document has to validate as OpenAPI JSON on its
// own. useAdminApi() assumes the envelope everywhere else, so this page
// calls $fetch directly instead of going through it.
const session = useSession()
const { t } = useI18n()
// ?document=data&role=<id>&path=<path> - the Endpoints list's "Open in API
// docs" lands here on one path of a role's document.
const route = useRoute()

// Two generated documents: the Admin API's (from the route table) and the
// Data API's, which is principal-effective - it only exists "as seen by"
// someone, so it's viewed per role (GET /admin/api/openapi/data?role=).
type DocumentKind = 'admin' | 'data'
const DOCUMENTS: Array<{ value: DocumentKind, label: string }> = [
  { value: 'admin', label: 'Admin API' },
  { value: 'data', label: 'Data API' }
]
const documentKind = ref<DocumentKind>(route.query.document === 'data' ? 'data' : 'admin')
const roleId = ref<string | undefined>(typeof route.query.role === 'string' ? route.query.role : undefined)
// GET /admin/api/openapi/data's `as`: the same role held by a signed-in
// user (session-only routes included) or by an API key.
type Principal = 'user' | 'api_key'
const PRINCIPALS = computed<Array<{ label: string, value: Principal }>>(() => [
  { label: t('content.docs.openapi.asUser'), value: 'user' },
  { label: t('content.docs.openapi.asApiKey'), value: 'api_key' }
])
const principal = ref<Principal>('user')

const { data: roles } = await useRoleOptions()
const roleItems = computed(() => roles.value.map(role => ({ label: role.name, value: role.id })))
const roleName = computed(() => roles.value.find(role => role.id === roleId.value)?.name)

const { data: spec, pending, error } = await useAsyncData(
  'openapi-document',
  () => {
    if (documentKind.value === 'data' && !roleId.value) return Promise.resolve(null)
    const url = documentKind.value === 'admin'
      ? '/admin/api/openapi'
      : `/admin/api/openapi/data?role=${encodeURIComponent(roleId.value!)}${principal.value === 'api_key' ? '&as=api_key' : ''}`
    return $fetch<Record<string, unknown>>(url, { headers: apiHeaders(session.token.value) })
  },
  { watch: [documentKind, roleId, principal] }
)

const pathCount = computed(() => {
  const paths = spec.value?.paths as Record<string, unknown> | undefined
  return paths ? Object.keys(paths).length : 0
})
const summary = computed(() => documentKind.value === 'admin'
  ? t('content.docs.openapi.adminSummary', { count: pathCount.value })
  : t('content.docs.openapi.dataSummary', { count: pathCount.value, role: roleName.value ?? t('content.docs.openapi.thisRole') }))
const fileBase = computed(() => documentKind.value === 'admin'
  ? 'totalbase-admin-openapi'
  : `totalbase-data-openapi-${(roleName.value ?? 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)

const prettyJson = computed(() => spec.value ? JSON.stringify(spec.value, null, 2) : '')

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function downloadJson() {
  if (!prettyJson.value) return
  downloadBlob(prettyJson.value, `${fileBase.value}.json`, 'application/json')
}

// Same document, saved as .txt for a caller that just wants to paste it
// somewhere without a .json extension getting in the way (e.g. into a
// chat, an issue, a doc).
function downloadText() {
  if (!prettyJson.value) return
  downloadBlob(prettyJson.value, `${fileBase.value}.txt`, 'text/plain')
}

const viewerRef = ref<{ wordWrap: boolean, toggleWordWrap: () => void, find: () => void, reveal: (text: string) => void } | null>(null)

// Land on the requested path once, as soon as the viewer shows the document.
let pendingPath = typeof route.query.path === 'string' ? route.query.path : null
watch(viewerRef, (viewer) => {
  if (!viewer || !pendingPath) return
  viewer.reveal(`${JSON.stringify(pendingPath)}: {`)
  pendingPath = null
}, { immediate: true })
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        title="OpenAPI"
        :description="t('content.docs.openapi.description')"
      />
    </template>

    <template #toolbar>
      <div class="flex flex-wrap items-center gap-3">
        <UFieldGroup>
          <UButton
            v-for="d in DOCUMENTS"
            :key="d.value"
            :label="d.label"
            :color="documentKind === d.value ? 'primary' : 'neutral'"
            :variant="documentKind === d.value ? 'soft' : 'outline'"
            @click="documentKind = d.value"
          />
        </UFieldGroup>
        <USelect
          v-if="documentKind === 'data'"
          v-model="roleId"
          :items="roleItems"
          value-key="value"
          :aria-label="t('common.role')"
          class="w-full sm:w-56"
        />
        <USelect
          v-if="documentKind === 'data'"
          v-model="principal"
          :items="PRINCIPALS"
          value-key="value"
          :aria-label="t('content.docs.openapi.principal')"
          class="w-full sm:w-48"
        />
      </div>
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

    <UEmpty
      v-else-if="documentKind === 'data' && !roleId"
      icon="i-lucide-shield"
      :title="t('content.docs.openapi.selectRole')"
      :description="t('content.docs.openapi.selectRoleDescription')"
    />

    <template v-else-if="spec">
      <!-- Toolbar - same square-button + divider layout as SqlConsolePanel's
      editor/results toolbar: search delegates to Monaco's own find widget
      (already supports regex/case toggles and jumps the viewport, which a
      bespoke text filter over the JSON string wouldn't) rather than
      reimplementing search. -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-muted">{{ summary }}</span>

        <div class="flex-1" />

        <UTooltip :text="t('content.docs.openapi.find')">
          <UButton
            :aria-label="t('content.docs.openapi.find')"
            icon="i-lucide-search"
            color="neutral"
            variant="outline"
            size="sm"
            square
            @click="viewerRef?.find()"
          />
        </UTooltip>
        <UTooltip :text="t('content.docs.openapi.wordWrap')">
          <UButton
            :aria-label="t('content.docs.openapi.wordWrap')"
            icon="i-lucide-wrap-text"
            :color="viewerRef?.wordWrap ? 'primary' : 'neutral'"
            variant="outline"
            size="sm"
            square
            @click="viewerRef?.toggleWordWrap()"
          />
        </UTooltip>

        <div class="w-px h-5 bg-border mx-1" />

        <UTooltip :text="t('content.docs.openapi.downloadJson')">
          <UButton
            :aria-label="t('content.docs.openapi.downloadJson')"
            icon="i-lucide-braces"
            color="neutral"
            variant="outline"
            size="sm"
            square
            @click="downloadJson"
          />
        </UTooltip>
        <UTooltip :text="t('content.docs.openapi.downloadText')">
          <UButton
            :aria-label="t('content.docs.openapi.downloadText')"
            icon="i-lucide-file-down"
            color="neutral"
            variant="outline"
            size="sm"
            square
            @click="downloadText"
          />
        </UTooltip>
      </div>

      <div class="border border-default rounded-lg overflow-hidden h-[70vh]">
        <JsonViewer
          ref="viewerRef"
          :model-value="prettyJson"
        />
      </div>
    </template>
  </PageShell>
</template>
