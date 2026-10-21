<script setup lang="ts">
import { operationMenu } from '@totalbase/tb-catalog'
import { useOperationCatalogText } from '~/utils/workflow-operations'

// Plain flow-layout card - no Vue Flow handles/positions. Same generic
// icon/title/subtitle shape WorkflowNode.vue used to render (still mirrors
// how ActionInvoker treats MAILING/PROXY/FUNCTION as variants of one shape),
// just without any canvas dependency.
type Kind = 'start' | 'condition' | 'action'

export interface AddSlot {
  /** The connection output this menu entry fills - 'next'/'true'/'false'/'error'. */
  output: string
  label: string
  icon: string
  iconClass: string
  /** Already wired to a child - offering it again would silently orphan that chain - or the step limit is reached. */
  disabled: boolean
  /** Why the entry is disabled when it isn't obvious (the step limit). */
  description?: string
}

const props = defineProps<{
  kind: Kind
  icon: string
  title: string
  subtitle: string
  color: 'primary' | 'warning' | 'success' | 'info' | 'neutral'
  /** Delete is only offered once every output this node owns is still an empty slot - see [id].vue's `canDelete`. */
  canDelete?: boolean
  /** One menu entry per output this node type has - each opens the catalog as a submenu instead of a separate inline "+" popover. */
  addSlots?: AddSlot[]
  /** This card is the head of its parent's error branch - a subtle red wash overrides `color` regardless of the node's own operation-type color. */
  errorTint?: boolean
  /** Nodes reachable from this one (any output, recursively) - above 0, Delete asks to confirm removing them too (and says how many). 0 means this node is a leaf: Delete removes it right away. */
  descendantCount?: number
  /** Short reference id other steps use to point at this one's output - shown in the card's own footer, first field in its config modal (see WorkflowStepKeyField.vue). */
  stepKey: string
  /** Hides the add/edit/delete menu entirely and makes the card unclickable - the Versions menu's read-only preview mode. */
  readOnly?: boolean
}>()

const emit = defineEmits<{ click: [], remove: [], removeCascade: [], add: [output: string, type: string] }>()
const deleteConfirmOpen = ref(false)
/** The delete modal's Confirm - Delete enables only once it is checked (AGENTS.md §25). */
const deleteConfirmed = ref(false)
watch(deleteConfirmOpen, (open) => {
  if (open) deleteConfirmed.value = false
})
/** A leaf removes just itself; otherwise every step below it goes too. */
function confirmDelete() {
  deleteConfirmOpen.value = false
  if (props.descendantCount) emit('removeCascade')
  else emit('remove')
}

const colorClasses: Record<string, string> = {
  primary: 'border-primary-300 dark:border-primary-800 bg-primary-50 dark:bg-primary-950/40',
  warning: 'border-warning-300 dark:border-warning-800 bg-warning-50 dark:bg-warning-950/40',
  success: 'border-success-300 dark:border-success-800 bg-success-50 dark:bg-success-950/40',
  info: 'border-info-300 dark:border-info-800 bg-info-50 dark:bg-info-950/40',
  neutral: 'border-default bg-elevated'
}

const iconColorClasses: Record<string, string> = {
  primary: 'text-primary-600 dark:text-primary-400',
  warning: 'text-warning-600 dark:text-warning-400',
  success: 'text-success-600 dark:text-success-400',
  info: 'text-info-600 dark:text-info-400',
  neutral: 'text-muted'
}

// The step menu: the operation catalog's groups (@totalbase/tb-catalog), each
// a section of its operations.
const { t } = useI18n()
const { operationTitle } = useOperationCatalogText()

function catalogChildren(output: string) {
  return operationMenu()
    .filter(entry => entry.operations.length > 0)
    .map(entry => entry.operations.map(operation => ({
      label: operationTitle(operation.type, operation.label),
      icon: operation.icon,
      onSelect: () => emit('add', output, operation.type)
    })))
}

const cardClasses = computed(() => props.errorTint ? 'border-error-300 dark:border-error-800 bg-error-50 dark:bg-error-950/40' : colorClasses[props.color])
const iconClasses = computed(() => props.errorTint ? 'text-error' : iconColorClasses[props.color])

const menuItems = computed(() => [
  (props.addSlots ?? []).map(slot => ({
    label: slot.label,
    icon: slot.icon,
    disabled: slot.disabled,
    ...(slot.description && { description: slot.description }),
    ui: { itemLeadingIcon: slot.iconClass },
    children: catalogChildren(slot.output)
  })),
  // One Delete, always confirmed - naming how many steps below go with it. Never on
  // Start: a definition holds exactly one (Workflows.md §3.2), so its
  // save would be refused - the trigger changes in Settings › Trigger instead.
  ...(props.kind === 'start'
    ? []
    : [[
        {
          label: t('common.delete'),
          icon: 'i-lucide-trash-2',
          color: 'error' as const,
          disabled: !props.canDelete && !props.descendantCount,
          onSelect: () => { deleteConfirmOpen.value = true }
        }
      ]])
])
</script>

<template>
  <div
    class="group relative w-48 rounded-md border px-2.5 py-1.5 shadow-sm transition-shadow"
    :class="[cardClasses, readOnly ? 'cursor-default' : 'cursor-pointer hover:shadow-md']"
    :role="readOnly ? undefined : 'button'"
    :tabindex="readOnly ? undefined : 0"
    :aria-label="readOnly ? undefined : props.title"
    @click="!readOnly && emit('click')"
    @keydown.enter.space.self.prevent="!readOnly && emit('click')"
  >
    <UDropdownMenu
      v-if="!readOnly"
      :items="menuItems"
      :content="{ align: 'end' }"
    >
      <UButton
        icon="i-lucide-ellipsis-vertical"
        :aria-label="$t('workflows.workflowStepCard.stepActions')"
        size="xs"
        color="neutral"
        variant="ghost"
        class="absolute top-1 right-1"
        @click.stop
      />
    </UDropdownMenu>

    <UModal
      v-model:open="deleteConfirmOpen"
      :title="props.descendantCount ? t('workflows.workflowStepCard.deleteStepsTitle') : t('workflows.workflowStepCard.deleteStepTitle')"
      :ui="{ content: 'max-w-sm' }"
    >
      <template #body>
        <p class="text-sm text-highlighted">
          <template v-if="props.descendantCount">
            {{ t('workflows.workflowStepCard.deleteWithDownstream', { title: props.title, n: props.descendantCount }, props.descendantCount) }}
          </template>
          <template v-else>
            {{ t('workflows.workflowStepCard.deleteOne', { title: props.title }) }}
          </template>
        </p>
        <p class="mt-1 text-xs text-muted">
          {{ props.descendantCount ? t('workflows.workflowStepCard.removesFollowing') : t('workflows.workflowStepCard.removesStep') }} {{ t('workflows.workflowStepCard.cannotUndo') }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <label class="flex cursor-pointer items-center gap-2">
            <UCheckbox v-model="deleteConfirmed" />
            <span class="text-sm">{{ t('common.confirm') }}</span>
          </label>
          <div class="flex gap-2">
            <UButton
              :label="$t('common.cancel')"
              color="neutral"
              variant="ghost"
              @click="deleteConfirmOpen = false"
            />
            <UButton
              :label="props.descendantCount ? t('workflows.workflowStepCard.deleteNSteps', { n: 1 + props.descendantCount }) : t('common.delete')"
              color="error"
              :disabled="!deleteConfirmed"
              @click="confirmDelete"
            />
          </div>
        </div>
      </template>
    </UModal>

    <div class="flex items-center gap-1.5 pr-5">
      <UIcon
        :name="props.icon"
        class="size-3.5 shrink-0"
        :class="iconClasses"
      />
      <span class="text-xs font-medium text-highlighted truncate">{{ props.title }}</span>
    </div>
    <p class="mt-0.5 text-xs text-muted truncate">
      {{ props.subtitle }}
    </p>
    <p class="mt-1 truncate border-t border-default/60 pt-1 font-mono text-xs text-dimmed">
      {{ props.stepKey }}
    </p>
  </div>
</template>
