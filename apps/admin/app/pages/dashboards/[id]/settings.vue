<script setup lang="ts">
/**
 * A dashboard's settings (Dashboards.md §10.5, D26) - in the format of a DataView's: its sections in the
 * toolbar, each its own URL (`?section=`), a header with **Dashboard design** to go back to the canvas. General (name,
 * slug, how the App presents it), Variables, Data (auto-refresh), Share (its embeds) and Security (the roles that open
 * it). What is versioned - the variables - applies on Publish; everything else at once, and each section says which.
 */
import { DASHBOARD_REFRESH_INTERVALS } from '@totalbase/tb-catalog'
import type { Dashboard, DashboardVersion } from '~/types/dashboard'
import { useDashboardCatalogText } from '~/types/dashboard'
import type { RoleColor } from '~/types/permission'
import { useApiErrorMessage } from '~/utils/api-error-message'

const route = useRoute()
const router = useRouter()
const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const catalog = useDashboardCatalogText()
const { refresh: refreshTree } = useAppsNavDashboards()
const dashboardId = String(route.params.id)

const { data: dashboard, error, refresh: refreshDashboard } = await useAsyncData(
  `dashboard-settings-${dashboardId}`,
  () => api.get<Dashboard & { hasUnpublishedChanges?: boolean }>(`/dashboards/${dashboardId}`).then(r => r.data)
)
const { data: versions, refresh: refreshVersions } = await useAsyncData(
  `dashboard-settings-versions-${dashboardId}`,
  () => api.get<DashboardVersion[]>(`/dashboards/${dashboardId}/versions`).then(r => r.data),
  { default: (): DashboardVersion[] => [] }
)
const published = computed(() => (versions.value?.length ?? 0) > 0)
const liveVersion = computed(() => versions.value?.[0]?.version ?? 0)
const notifyError = useErrorToast()

// Publish, as on the canvas (Admin_UI.md §3.7): what is versioned here - the variables - goes live.
const publishing = ref(false)
async function publish(note?: string) {
  publishing.value = true
  try {
    await autosave.flush()
    const { data } = await api.post<DashboardVersion>(`/dashboards/${dashboardId}/publish`, note ? { data: { note } } : undefined)
    await Promise.all([refreshVersions(), refreshDashboard()])
    toast.add({ title: t('dashboards.editor.published', { version: data.version }), color: 'success' })
  } catch (error) {
    notifyError(error, t('dashboards.editor.publishFailed'))
  } finally {
    publishing.value = false
  }
}

// --- Sections ---
type SectionKey = 'general' | 'variables' | 'data' | 'share' | 'security' | 'versions'
const SECTIONS: { key: SectionKey, icon: string }[] = [
  { key: 'general', icon: 'i-lucide-settings-2' },
  { key: 'variables', icon: 'i-lucide-variable' },
  { key: 'data', icon: 'i-lucide-database' },
  { key: 'share', icon: 'i-lucide-share-2' },
  { key: 'security', icon: 'i-lucide-shield' },
  { key: 'versions', icon: 'i-lucide-git-commit-vertical' }
]
const section = computed<SectionKey>(() => {
  const asked = route.query.section as SectionKey
  return SECTIONS.some(s => s.key === asked) ? asked : 'general'
})
const sectionItems = computed(() => SECTIONS.map(s => ({
  label: t(`dashboards.settings.sections.${s.key}`),
  icon: s.icon,
  to: { query: { section: s.key } },
  active: section.value === s.key
})))
// A section mounts on its first visit and stays - switching back keeps its state.
const visited = ref(new Set<SectionKey>())
watch(section, key => visited.value.add(key), { immediate: true })

// --- General and Data: saved as they change (not versioned - at once) ---
const name = ref('')
const slug = ref('')
const slugTouched = ref(true)
const description = ref<string | null>(null)
const menuLabel = ref<string | null>(null)
const icon = ref<string | undefined>(undefined)
const color = ref<RoleColor | undefined>(undefined)
const scope = ref<'LISTED' | 'EMBEDDED_ONLY'>('LISTED')
/** 0 = off (a select item can't hold null); sent as null. */
const refreshInterval = ref(0)
const refreshIntervalOptions = computed(() => [{ label: t('dashboards.detailsModal.refreshOff'), value: 0 }, ...DASHBOARD_REFRESH_INTERVALS.map(i => ({ label: catalog.refreshLabel(i.seconds, i.label), value: i.seconds }))])

let seeded = false
watch(dashboard, (value) => {
  if (!value || seeded) return
  seeded = true
  name.value = value.name
  slug.value = value.slug
  description.value = value.description
  menuLabel.value = value.menuLabel ?? null
  icon.value = value.icon ?? undefined
  color.value = value.color ?? undefined
  scope.value = value.scope ?? 'LISTED'
  refreshInterval.value = value.refreshIntervalSeconds ?? 0
}, { immediate: true })

const body = computed(() => ({
  name: name.value,
  slug: slug.value,
  description: description.value,
  menuLabel: menuLabel.value,
  icon: icon.value ?? null,
  color: color.value ?? null,
  scope: scope.value,
  refreshIntervalSeconds: refreshInterval.value || null
}))
let lastSaved = ''
watch(dashboard, (value) => {
  if (value && !lastSaved) lastSaved = JSON.stringify(body.value)
}, { immediate: true })
const autosave = useAutosave(async () => {
  if (!name.value.trim() || !slug.value.trim()) return
  const sent = JSON.stringify(body.value)
  if (sent === lastSaved) return
  try {
    await api.patch(`/dashboards/${dashboardId}`, { data: body.value })
    lastSaved = sent
    void refreshTree()
  } catch (err) {
    toast.add({ title: errorMessage(err, t('dashboards.detailsModal.saveFailed')), color: 'error' })
    throw err
  }
})
watch(body, () => {
  if (seeded) autosave.schedule()
}, { deep: true })

// --- Variables: versioned - applies on Publish ---
function onVariablesSaved(saved: Dashboard) {
  dashboard.value = { ...dashboard.value!, ...saved }
  void refreshDashboard()
  toast.add({ title: t('dashboards.editor.variablesSaved'), color: 'success' })
}

// Whether managers may open it to the roles below theirs (Security.md §9.7) - applies at once, never versioned.
const savingDelegable = ref(false)
async function setDelegable(delegable: boolean) {
  savingDelegable.value = true
  try {
    await api.patch(`/dashboards/${dashboardId}`, { data: { delegable } })
    await refreshDashboard()
  } catch (err) {
    notifyError(err, t('dashboards.settings.delegableError'))
  } finally {
    savingDelegable.value = false
  }
}

async function onRestored() {
  await Promise.all([refreshDashboard(), refreshVersions()])
}
async function backToDesign() {
  await autosave.flush()
  await router.push(`/dashboards/${dashboardId}`)
}
</script>

<template>
  <PageShell :scroll="false">
    <template #header>
      <PageHeader
        :title="name || dashboard?.name || ''"
        :description="description ?? undefined"
        :icon="dashboard?.icon ?? 'i-lucide-layout-dashboard'"
        height="editor"
      >
        <template #status>
          <SaveStatus
            :status="autosave.status.value"
            @retry="autosave.retry()"
          />
        </template>
        <!-- The other screen, then publishing (Admin_UI.md §3.7). -->
        <UButton
          icon="i-lucide-layout-dashboard"
          :label="t('dashboards.settings.design')"
          color="neutral"
          variant="outline"
          @click="backToDesign"
        />
        <UnpublishedChangesBadge v-if="dashboard?.hasUnpublishedChanges" />
        <DiagnosisBadge
          :key="`diagnosis-${liveVersion}`"
          kind="dashboard"
          :object-id="dashboardId"
        />
        <PublishButton
          :diagnosis="{ kind: 'dashboard', objectId: dashboardId }"
          :loading="publishing"
          :disabled="!dashboard?.hasUnpublishedChanges"
          :next-version="liveVersion + 1"
          :note="t('dashboards.editor.publishHelp')"
          @publish="publish"
        />
      </PageHeader>
    </template>
    <template
      v-if="!error && dashboard"
      #toolbar
    >
      <UNavigationMenu
        :items="sectionItems"
        orientation="horizontal"
        highlight
        :aria-label="t('dashboards.settings.sections.nav')"
        :ui="{ item: 'shrink-0' }"
        class="overflow-x-auto"
      />
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />
    <div
      v-else-if="dashboard"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto max-md:-mr-4 max-md:pr-4"
    >
      <div
        class="mx-auto flex w-full flex-col gap-8 pb-12"
        :class="section === 'share' ? 'flex-1' : 'max-w-3xl'"
      >
        <SettingsSection
          v-if="visited.has('general')"
          v-show="section === 'general'"
          :title="t('dashboards.settings.sections.general')"
        >
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-zap"
            :title="t('dashboards.settings.appliesAtOnce')"
          />
          <NameSlugFields
            v-model:name="name"
            v-model:slug="slug"
            v-model:slug-touched="slugTouched"
            :slug-locked="published"
            hide-description
          />
        </SettingsSection>
        <SettingsSection
          v-if="visited.has('general')"
          v-show="section === 'general'"
          :title="t('shell.appPresentation.heading')"
          class="mt-4"
        >
          <AppPresentationFields
            v-model:scope="scope"
            v-model:menu-label="menuLabel"
            v-model:description="description"
            v-model:icon="icon"
            v-model:color="color"
            kind="Dashboard"
          />
        </SettingsSection>

        <DashboardVariablesSettings
          v-if="visited.has('variables')"
          v-show="section === 'variables'"
          :dashboard="dashboard"
          @saved="onVariablesSaved"
        />

        <SettingsSection
          v-if="visited.has('data')"
          v-show="section === 'data'"
          :title="t('dashboards.settings.sections.data')"
        >
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-zap"
            :title="t('dashboards.settings.appliesAtOnce')"
          />
          <UFormField
            :label="t('dashboards.detailsModal.autoRefresh')"
            :description="t('dashboards.detailsModal.autoRefreshHelp')"
          >
            <USelect
              v-model="refreshInterval"
              :aria-label="t('dashboards.detailsModal.autoRefresh')"
              :items="refreshIntervalOptions"
              class="w-full"
            />
          </UFormField>
        </SettingsSection>

        <DashboardShareSettings
          v-if="visited.has('share')"
          v-show="section === 'share'"
          :dashboard="dashboard"
          :active="section === 'share'"
          @saved="refreshDashboard()"
        />

        <ObjectSecuritySettings
          v-if="visited.has('security')"
          v-show="section === 'security'"
          kind="dashboard"
          :object-id="dashboard.id"
          :source-resource="null"
        >
          <!-- Security.md §9.7: its SQL bypasses the resolver, so a manager shares it only on an administrator's word. -->
          <USwitch
            :model-value="dashboard.delegable === true"
            :loading="savingDelegable"
            :label="t('dashboards.settings.delegable')"
            :description="t('dashboards.settings.delegableHelp')"
            @update:model-value="(v: boolean) => setDelegable(v)"
          />
        </ObjectSecuritySettings>

        <!-- Versions (Foundations.md §13.7): a version opens on the canvas, read-only. -->
        <VersionsTimeline
          v-if="visited.has('versions')"
          v-show="section === 'versions'"
          pillar="dashboards"
          :object-id="dashboard.id"
          :object-name="dashboard.name"
          :versions="versions ?? []"
          :has-unpublished-changes="dashboard.hasUnpublishedChanges ?? true"
          :publishing="publishing"
          :publish-note="t('dashboards.editor.publishHelp')"
          :before-restore="() => autosave.flush()"
          @open="(version: number) => navigateTo({ path: `/dashboards/${dashboardId}`, query: { version } })"
          @publish="publish"
          @restored="onRestored"
          @deleted="() => refreshVersions()"
        />
      </div>
    </div>
  </PageShell>
</template>
