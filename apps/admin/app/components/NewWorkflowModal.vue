<script setup lang="ts">
/**
 * Creation wizard (Specification_Workflows.md §16.1) on the
 * product's WizardModal (AGENTS.md "Multi-step wizards"):
 * 1) identification (name/description/slug), 2) triggering event - a bare
 * card picker, 3) that trigger's own configuration (its shape depends on
 * step 2's choice), which becomes the mandatory Start node's
 * `configuration` at creation time instead of an empty object, 4) auditing
 * (history preference). Creating still never enables execution -
 * `enabled` stays false regardless of what's picked here.
 *
 * Steps 2/3 delegate to WorkflowTriggerFields.vue (cards + per-kind config,
 * shared with EditWorkflowTriggerModal.vue's edit wizard) - see that
 * file's own doc comment for the Specification_Workflows.md §6 reasoning
 * behind each trigger kind's fields.
 */
import WorkflowTriggerFields from '~/components/WorkflowTriggerFields.vue'
import WorkflowInvokeRolesField from '~/components/workflows/WorkflowInvokeRolesField.vue'
import WorkflowHistoryFields from '~/components/workflows/WorkflowHistoryFields.vue'
import { useTriggerConfigMeta, type TriggerOption } from '~/utils/workflow-triggers'
import type { WizardStep } from '~/components/WizardModal.vue'

interface Workflow { id: string, name: string, description: string | null, slug: string }

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [Workflow] }>()

const api = useAdminApi()
const toast = useToast()

const saving = ref(false)

const identity = ref({ name: '', description: null as string | null, slug: '', slugTouched: false })
const { t } = useI18n()
const triggerConfigMeta = useTriggerConfigMeta()

const triggerKind = ref<TriggerOption['value'] | null>(null)
const triggerValid = ref(false)
const triggerFields = useTemplateRef('triggerFields')

// Defaults to DETAILED, not SUMMARY - a brand-new workflow's author is
// almost always still building/testing it, and SUMMARY (no input/result
// payload ever persisted, by design - see engine.ts's own
// TEMPLATED_OPERATION_TYPES doc comment) makes Logs' step detail useless
// for exactly that early phase. Freely switchable to SUMMARY later via
// EditWorkflowTriggerModal's own Auditing step, once the design has
// settled and payload retention starts to matter more than visibility.
const historyEnabled = ref(true)
const historyLevel = ref<'SUMMARY' | 'DETAILED'>('DETAILED')
const roleIds = ref<string[]>([])

function reset() {
  identity.value = { name: '', description: null, slug: '', slugTouched: false }
  triggerKind.value = null
  triggerValid.value = false
  historyEnabled.value = true
  historyLevel.value = 'DETAILED'
  roleIds.value = []
}

watch(open, (value) => {
  if (value) reset()
})

const steps = computed<WizardStep[]>(() => [
  { key: 'identity', title: t('workflows.wizard.identity.title'), description: t('workflows.wizard.identity.description'), valid: identity.value.name.trim().length > 0 && identity.value.slug.trim().length > 0 },
  // Only requires picking a card - its own fields (if any) are the next step.
  { key: 'trigger', title: t('workflows.wizard.trigger.title'), description: t('workflows.wizard.trigger.description'), valid: triggerKind.value !== null },
  { key: 'triggerConfig', ...(triggerKind.value ? triggerConfigMeta.value[triggerKind.value] : { title: t('workflows.wizard.triggerConfig.title'), description: t('workflows.wizard.triggerConfig.description') }), valid: triggerValid.value },
  { key: 'access', title: t('workflows.wizard.access.title'), description: t('workflows.wizard.access.description') },
  { key: 'audit', title: t('workflows.wizard.audit.title'), description: t('workflows.wizard.audit.description') }
])

async function create() {
  saving.value = true
  try {
    const { data } = await api.post<Workflow>('/workflows', {
      data: {
        name: identity.value.name,
        description: identity.value.description,
        slug: identity.value.slug,
        historyEnabled: historyEnabled.value,
        historyLevel: historyLevel.value,
        startConfiguration: triggerFields.value?.buildConfiguration() ?? { trigger: 'MANUAL' }
      }
    })
    if (roleIds.value.length > 0) {
      await api.put(`/workflows/${data.id}/roles`, { data: { roleIds: roleIds.value } })
    }
    open.value = false
    emit('created', data)
  } catch {
    toast.add({ title: t('workflows.newModal.createFailed'), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <WizardModal
    v-model:open="open"
    :title="t('workflows.newModal.title')"
    :description="t('workflows.newModal.description')"
    :steps="steps"
    :submit-label="t('common.create')"
    :submitting="saving"
    @submit="create"
  >
    <template #identity>
      <NameSlugFields
        v-model:name="identity.name"
        v-model:description="identity.description"
        v-model:slug="identity.slug"
        v-model:slug-touched="identity.slugTouched"
      />
    </template>

    <!-- Spans two steps (the cards, then that kind's configuration) and
    owns per-kind state (cron/webhook/etc.) that isn't lifted to this
    parent - so it lives in the always-mounted default slot. -->
    <template #default="{ current }">
      <WorkflowTriggerFields
        v-show="current === 'trigger' || current === 'triggerConfig'"
        ref="triggerFields"
        v-model:kind="triggerKind"
        :view="current === 'triggerConfig' ? 'config' : 'cards'"
        @update:valid="triggerValid = $event"
      />
    </template>

    <template #access>
      <WorkflowInvokeRolesField v-model="roleIds" />
    </template>

    <template #audit>
      <WorkflowHistoryFields
        v-model:enabled="historyEnabled"
        v-model:level="historyLevel"
      />
      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        :title="t('workflows.newModal.notActivatedTitle')"
        :description="t('workflows.newModal.notActivatedDescription')"
        class="mt-4"
      />
    </template>
  </WizardModal>
</template>
