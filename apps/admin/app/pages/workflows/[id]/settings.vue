<script setup lang="ts">
/**
 * A workflow's settings (Workflows.md §16) - in the format of a Dashboard's: its sections in the
 * toolbar, each its own URL (`?section=`), a header with **Workflow design** to go back to the canvas. General (name,
 * slug, description, enabled), Trigger (the event and its configuration - the Start node's, versioned: it reaches
 * production on Publish; General also holds what a run keeps), Security (the roles that may invoke it) and Runs (its
 * executions, WorkflowRunsTable.vue - full width, `?run=` opens one). Everything but the trigger applies at once,
 * and each section says which. Edits autosave, as on the canvas.
 */
import type { WorkflowDraft, WorkflowVersionRecord } from '~/composables/useWorkflowVersions'
import WorkflowInvokeRolesField from '~/components/workflows/WorkflowInvokeRolesField.vue'
import WorkflowHistoryFields from '~/components/workflows/WorkflowHistoryFields.vue'
import WorkflowTriggerFields from '~/components/WorkflowTriggerFields.vue'
import WorkflowRunsTable from '~/components/workflows/WorkflowRunsTable.vue'
import WorkflowDisabledBadge from '~/components/workflows/WorkflowDisabledBadge.vue'
import type { TriggerOption } from '~/utils/workflow-triggers'

const route = useRoute()
const router = useRouter()
const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()
const toast = useToast()
const workflowId = String(route.params.id)

const { data: draft, error, refresh: refreshDraft } = await useAsyncData(`workflow-settings-${workflowId}`, () => api.get<WorkflowDraft>(`/workflows/${workflowId}/draft`).then(r => r.data), { deep: true })
const { data: roleIds } = await useAsyncData(`workflow-settings-roles-${workflowId}`, () => api.get<string[]>(`/workflows/${workflowId}/roles`).then(r => r.data), { default: (): string[] => [] })
const startNode = computed(() => draft.value?.definition.operations.find(node => node.type === 'totalbase.start'))
// The versions (the Runs filter and a run's version number) and the steps' names, from the draft's operations.
const { data: versions, refresh: refreshVersions } = await useAsyncData(`workflow-settings-versions-${workflowId}`, () => api.get<WorkflowVersionRecord[]>(`/workflows/${workflowId}/versions`).then(r => r.data), { default: (): WorkflowVersionRecord[] => [] })
const operationNames = computed(() => (draft.value?.definition.operations ?? []).map(o => ({ id: o.id, key: o.key ?? '', label: (o.label as string | undefined) ?? o.key ?? o.type })))

// --- Sections ---
type SectionKey = 'general' | 'trigger' | 'security' | 'versions' | 'runs'
const SECTIONS: { key: SectionKey, icon: string }[] = [
  { key: 'general', icon: 'i-lucide-settings-2' },
  { key: 'trigger', icon: 'i-lucide-zap' },
  { key: 'security', icon: 'i-lucide-shield' },
  { key: 'versions', icon: 'i-lucide-git-commit-vertical' },
  { key: 'runs', icon: 'i-lucide-history' }
]
const section = computed<SectionKey>(() => {
  const asked = route.query.section as SectionKey
  return SECTIONS.some(s => s.key === asked) ? asked : 'general'
})
const sectionItems = computed(() => SECTIONS.map(s => ({
  label: t(`workflows.settings.sections.${s.key}`),
  icon: s.icon,
  to: { query: { section: s.key } },
  active: section.value === s.key
})))
const visited = ref(new Set<SectionKey>())
watch(section, key => visited.value.add(key), { immediate: true })

// --- General and Auditing: one PATCH with the revision, saved as they change ---
const name = ref('')
const slug = ref('')
const description = ref<string | null>(null)
const enabled = ref(false)
const historyEnabled = ref(true)
const historyLevel = ref<'SUMMARY' | 'DETAILED'>('SUMMARY')
let seeded = false
watch(draft, (value) => {
  if (!value || seeded) return
  seeded = true
  name.value = value.workflow.name
  slug.value = value.workflow.slug
  description.value = value.workflow.description
  enabled.value = value.workflow.enabled
  historyEnabled.value = value.workflow.historyEnabled
  historyLevel.value = value.workflow.historyLevel
}, { immediate: true })
const body = computed(() => ({ name: name.value.trim(), slug: slug.value.trim(), description: description.value, enabled: enabled.value, historyEnabled: historyEnabled.value, historyLevel: historyLevel.value }))
let lastSaved = ''
watch(draft, (value) => {
  if (value && !lastSaved) lastSaved = JSON.stringify(body.value)
}, { immediate: true })
const autosave = useAutosave(async () => {
  if (!draft.value || !body.value.name || !body.value.slug) return
  const sent = JSON.stringify(body.value)
  if (sent === lastSaved) return
  const workflow = draft.value.workflow
  const patch = Object.fromEntries(Object.entries(body.value).filter(([key, value]) => workflow[key as keyof typeof body.value] !== value))
  try {
    const { data } = await api.patch<WorkflowDraft['workflow']>(`/workflows/${workflowId}`, { data: { revision: workflow.revision, ...patch } })
    draft.value.workflow = data
    lastSaved = sent
    void refreshNuxtData('workflows-tree')
  } catch (err) {
    notifyError(err, t('workflows.editor.settingsUpdateFailed'))
    throw err
  }
})
watch(body, () => {
  if (seeded) autosave.schedule()
}, { deep: true })
// Enabling needs a published version (the server refuses otherwise); the switch says so instead of a round trip.
const canEnable = computed(() => Boolean(draft.value?.workflow.publishedVersion))
const autoDisabled = computed(() => !draft.value?.workflow.enabled && (draft.value?.workflow.consecutiveFailures ?? 0) > 0)

// --- Trigger: the Start node's configuration, part of the draft - reaches production on Publish ---
const triggerKind = ref<TriggerOption['value'] | null>(null)
const triggerValid = ref(false)
const triggerFields = useTemplateRef('triggerFields')
watch(startNode, (node) => {
  if (node && triggerKind.value === null) triggerKind.value = (node.configuration.trigger as TriggerOption['value'] | undefined) ?? null
}, { immediate: true })
const triggerSave = useAutosave(async () => {
  if (!draft.value || !startNode.value || !triggerValid.value) return
  const configuration = triggerFields.value?.buildConfiguration()
  if (!configuration || JSON.stringify(configuration) === JSON.stringify(startNode.value.configuration)) return
  startNode.value.configuration = configuration
  try {
    const { data } = await api.put<WorkflowDraft>(`/workflows/${workflowId}/draft`, { data: { revision: draft.value.workflow.revision, definition: draft.value.definition } })
    draft.value.workflow = data.workflow
    void refreshNuxtData('workflows-tree')
  } catch (err) {
    notifyError(err, t('workflows.editor.saveFailed'))
    throw err
  }
})
function onTriggerChange() {
  if (visited.value.has('trigger')) triggerSave.schedule()
}

// --- Security: the roles that may invoke it, replaced at once ---
async function onRolesChange(value: string[]) {
  const previous = roleIds.value
  roleIds.value = value
  await autosave.track((async () => {
    try {
      roleIds.value = (await api.put<string[]>(`/workflows/${workflowId}/roles`, { data: { roleIds: value } })).data
    } catch (err) {
      roleIds.value = previous
      notifyError(err, t('workflows.editor.accessUpdateFailed'))
      throw err
    }
  })())
}

const status = computed(() => triggerSave.status.value === 'saving' || triggerSave.status.value === 'error' ? triggerSave.status.value : autosave.status.value)
// Publish, as on the canvas (Admin_UI.md §3.7): what is versioned here - the trigger - goes live.
const publishing = ref(false)
async function publish(note?: string) {
  if (!draft.value) return
  publishing.value = true
  try {
    await Promise.all([autosave.flush(), triggerSave.flush()])
    const previous = draft.value.workflow.liveVersion
    const { data } = await api.post<{ liveVersion: number | null }>(`/workflows/${workflowId}/publish`, { data: { revision: draft.value.workflow.revision, ...(note && { note }) } })
    await Promise.all([refreshDraft(), refreshVersions()])
    toast.add(data.liveVersion === previous
      ? { title: t('workflows.editor.nothingToPublish'), description: t('workflows.editor.alreadyLive', { version: previous }), color: 'neutral' }
      : { title: t('workflows.editor.published'), color: 'success' })
  } catch (error) {
    notifyError(error, t('workflows.editor.publishFailed'))
  } finally {
    publishing.value = false
  }
}
async function flushAll() {
  await Promise.all([autosave.flush(), triggerSave.flush()])
}
async function onRestored() {
  await Promise.all([refreshDraft(), refreshVersions()])
}
async function backToDesign() {
  await Promise.all([autosave.flush(), triggerSave.flush()])
  await router.push(`/workflows/${workflowId}`)
}
</script>

<template>
  <PageShell :scroll="false">
    <template #header>
      <PageHeader
        :title="name || draft?.workflow.name || ''"
        :description="description ?? undefined"
        icon="i-lucide-workflow"
        height="editor"
      >
        <template #status>
          <SaveStatus
            :status="status"
            @retry="autosave.retry(); triggerSave.retry()"
          />
        </template>
        <!-- The other screen, then the state, versions and Publish (Admin_UI.md §3.7). -->
        <UButton
          icon="i-lucide-workflow"
          :label="t('workflows.settings.design')"
          color="neutral"
          variant="outline"
          @click="backToDesign"
        />
        <WorkflowDisabledBadge
          v-if="draft"
          :workflow="draft.workflow"
        />
        <UnpublishedChangesBadge v-if="draft?.workflow.hasUnpublishedChanges" />
        <PublishButton
          :loading="publishing"
          :disabled="!draft?.workflow.hasUnpublishedChanges"
          :next-version="(draft?.workflow.liveVersion ?? 0) + 1"
          :note="t('workflows.editor.publishDescription')"
          @publish="publish"
        />
      </PageHeader>
    </template>
    <template
      v-if="!error && draft"
      #toolbar
    >
      <UNavigationMenu
        :items="sectionItems"
        orientation="horizontal"
        highlight
        :aria-label="t('workflows.settings.sections.nav')"
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
      v-else-if="draft"
      class="flex min-h-0 flex-1 flex-col max-md:-mr-4 max-md:pr-4"
      :class="section === 'runs' ? undefined : 'overflow-y-auto'"
    >
      <div
        class="mx-auto flex w-full flex-col gap-8"
        :class="section === 'runs' ? 'min-h-0 flex-1' : 'max-w-3xl pb-12'"
      >
        <SettingsSection
          v-if="visited.has('general')"
          v-show="section === 'general'"
          :title="t('workflows.settings.sections.general')"
        >
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-zap"
            :title="t('workflows.settings.appliesAtOnce')"
          />
          <NameSlugFields
            v-model:name="name"
            v-model:description="description"
            v-model:slug="slug"
            slug-touched
          />
          <USwitch
            v-model="enabled"
            :label="t('common.enabled')"
            :description="!enabled && !canEnable ? t('workflows.editor.publishBeforeEnabling') : autoDisabled ? t('workflows.editor.autoDisabledTooltip', { n: draft.workflow.consecutiveFailures }) : t('workflows.settings.enabledHelp')"
            :disabled="!enabled && !canEnable"
          />
        </SettingsSection>
        <SettingsSection
          v-if="visited.has('general')"
          v-show="section === 'general'"
          :title="t('workflows.settings.retention')"
          class="mt-4"
        >
          <WorkflowHistoryFields
            v-model:enabled="historyEnabled"
            v-model:level="historyLevel"
          />
        </SettingsSection>

        <SettingsSection
          v-if="visited.has('trigger')"
          v-show="section === 'trigger'"
          :title="t('workflows.settings.sections.trigger')"
        >
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-upload"
            :title="t('workflows.settings.appliesOnPublish')"
          />
          <WorkflowTriggerFields
            ref="triggerFields"
            v-model:kind="triggerKind"
            view="all"
            :initial="startNode?.configuration"
            :workflow-id="workflowId"
            @update:valid="triggerValid = $event; onTriggerChange()"
            @change="onTriggerChange"
          />
        </SettingsSection>

        <SettingsSection
          v-if="visited.has('security')"
          v-show="section === 'security'"
          :title="t('workflows.settings.sections.security')"
        >
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-zap"
            :title="t('workflows.settings.appliesAtOnce')"
          />
          <WorkflowInvokeRolesField
            :model-value="roleIds"
            @update:model-value="onRolesChange"
          />
        </SettingsSection>

        <!-- Versions (Foundations.md §13.7): a version opens on the canvas, read-only. -->
        <VersionsTimeline
          v-if="visited.has('versions')"
          v-show="section === 'versions'"
          pillar="workflows"
          :object-id="workflowId"
          :object-name="draft.workflow.name"
          :versions="versions ?? []"
          :has-unpublished-changes="draft.workflow.hasUnpublishedChanges"
          :publishing="publishing"
          :publish-note="t('workflows.editor.publishDescription')"
          :restore-body="() => ({ revision: draft!.workflow.revision })"
          :before-restore="flushAll"
          @open="(version: number) => navigateTo({ path: `/workflows/${workflowId}`, query: { version } })"
          @publish="publish"
          @restored="onRestored"
          @deleted="() => refreshVersions()"
        />

        <WorkflowRunsTable
          v-if="visited.has('runs')"
          v-show="section === 'runs'"
          :workflow-id="workflowId"
          :versions="versions"
          :operations="operationNames"
          class="min-h-0 flex-1"
        />
      </div>
    </div>
  </PageShell>
</template>
