<script setup lang="ts">
import WorkflowStepKeyField from '~/components/workflows/WorkflowStepKeyField.vue'
/**
 * Configures a `totalbase.execute-sql` node's `configuration`: a raw SQL
 * statement plus the user it runs "as" for audit purposes only - per the
 * chat, this step deliberately does NOT go through role/permission
 * checks (it's a superuser-level escape hatch), so `executeAs` records
 * who to attribute the run to in history, not who it's authorized as.
 * Anyone who can edit this workflow can add this step - no extra gate
 * for now.
 */

export interface ExecuteSqlConfiguration {
  statement?: string
  executeAs?: string
}

const props = defineProps<{ modelValue: ExecuteSqlConfiguration, nodeKey: string, existingKeys: string[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [{ key: string, configuration: ExecuteSqlConfiguration }] }>()
const keyValue = ref('')
const keyValid = computed(() => keyValue.value.length > 0 && keyValue.value !== 'start' && keyValue.value !== 'item' && !props.existingKeys.includes(keyValue.value))

const statement = ref('')
const executeAs = ref<string | undefined>(undefined)

watch(open, (value) => {
  if (!value) return
  keyValue.value = props.nodeKey
  statement.value = props.modelValue.statement ?? ''
  executeAs.value = props.modelValue.executeAs
})

function save() {
  emit('save', { key: keyValue.value, configuration: { statement: statement.value, executeAs: executeAs.value } })
  open.value = false
}
// A phone or tablet gets this editor fullscreen (AGENTS.md section 25, modals).
const isCompact = useCompactUi()
</script>

<template>
  <UModal
    v-model:open="open"
    :fullscreen="isCompact"
    :title="$t('workflows.executeSqlModal.executeSql')"
    :description="$t('workflows.executeSqlModal.runsARawStatementNo')"
    :ui="{ content: isCompact ? undefined : 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <WorkflowStepKeyField
          v-model="keyValue"
          :existing-keys="existingKeys"
        />

        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="$t('workflows.executeSqlModal.noPermissionChecks')"
          :description="$t('workflows.executeSqlModal.thisStatementRunsDirectlyIt')"
        />

        <UFormField
          :label="$t('workflows.executeSqlModal.executeAs')"
          :description="$t('workflows.executeSqlModal.recordedForAuditPurposesOnly')"
        >
          <UserPicker
            v-model="executeAs"
            active-only
          />
        </UFormField>

        <UFormField :label="$t('workflows.executeSqlModal.statement')">
          <CodeEditor
            v-model="statement"
            language="sql"
            min-height="14rem"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="$t('common.cancel')"
          @click="open = false"
        />
        <UButton
          :label="$t('common.save')"
          :disabled="!keyValid"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
