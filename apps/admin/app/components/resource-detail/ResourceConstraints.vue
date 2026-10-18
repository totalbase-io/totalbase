<script setup lang="ts">
// Check constraints tab for the Resources drawer (roles/[id].vue's own
// "Payload check" is an application-level, per-role equivalent - see the
// chat that added this: this is the real thing, a PostgreSQL CHECK
// enforced for every writer, no matter how they reach the table -
// visibility that only lived in Console's old schema editor
// until now. Table-only: a VIEW has no rows of its own to constrain.
import type { Resource } from '~/types/resource'
import type { TableColumn } from '@nuxt/ui'
import type { CheckConstraintDefinition } from '~/types/schema'
import { humanizeCondition, type Condition } from '~/utils/filterConditions'

const props = defineProps<{ resource: Resource }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

// The table's detail, shared with the Columns panel (useTableDetail) - the checks it holds.
const { detail, pending, error, refresh } = useTableDetail(() => props.resource.id)

const columns = computed(() => detail.value?.columns ?? [])

const COLUMNS = computed<TableColumn<CheckConstraintDefinition>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { id: 'columns', header: t('database.resourceConstraints.columns') },
  { id: 'expression', header: t('database.resourceConstraints.expression') },
  { id: 'actions', header: '', meta: { class: { td: 'text-right' } } }
])

// --- Add check constraint ---
const isAddOpen = ref(false)
const checkName = ref('')
const checkExpression = ref('')
const checkMessage = ref('')
const saving = ref(false)
const isBuilderOpen = ref(false)

// The builder's conditions are sent as they are (`conditions`) and the
// server writes the expression from them - the admin never builds SQL
// (AGENTS.md §6). Either that list or a hand-written `expression`: while
// conditions exist the textarea rests, cleared of them it is the way in.
const builtConditions = ref<Condition[]>([])
const builtSummaries = computed(() => builtConditions.value.map(humanizeCondition))
const canAdd = computed(() => checkName.value.trim() !== '' && (builtConditions.value.length > 0 || checkExpression.value.trim() !== ''))

function openAdd() {
  checkName.value = ''
  checkExpression.value = ''
  checkMessage.value = ''
  builtConditions.value = []
  isAddOpen.value = true
}

function addCondition(condition: Condition) {
  builtConditions.value = [...builtConditions.value, condition]
  isBuilderOpen.value = false
}

function removeCondition(index: number) {
  builtConditions.value = builtConditions.value.filter((_, i) => i !== index)
}

async function addCheck() {
  if (!canAdd.value) return
  saving.value = true
  try {
    await api.post(`/schema/${props.resource.schema}/tables/${props.resource.name}/checks`, {
      data: {
        name: checkName.value.trim(),
        ...(builtConditions.value.length > 0
          ? { conditions: builtConditions.value.map(c => ({ field: c.field, operator: c.operator, value: c.value })) }
          : { expression: checkExpression.value.trim() }),
        message: checkMessage.value.trim() || null
      }
    })
    toast.add({ title: t('database.resourceConstraints.added'), color: 'success' })
    isAddOpen.value = false
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceConstraints.addError'))
  } finally {
    saving.value = false
  }
}

// --- Its message (its COMMENT): what a user reads when a write breaks it - edited in place ---
const editingMessage = ref<string | null>(null)
const messageDraft = ref('')
const savingMessage = ref(false)
function openMessage(check: CheckConstraintDefinition, open: boolean) {
  editingMessage.value = open ? check.name : null
  if (open) messageDraft.value = check.message ?? ''
}
async function saveMessage(name: string) {
  savingMessage.value = true
  try {
    await api.post(`/schema/${props.resource.schema}/tables/${props.resource.name}/edit`, {
      data: { operations: [{ kind: 'set_constraint_message', name, message: messageDraft.value.trim() || null }] }
    })
    toast.add({ title: t('database.resourceConstraints.messageSaved'), color: 'success' })
    editingMessage.value = null
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceConstraints.messageError'))
  } finally {
    savingMessage.value = false
  }
}

// --- Remove ---
const removing = ref<string | null>(null)
async function removeCheck(name: string) {
  removing.value = name
  try {
    await api.del(`/schema/${props.resource.schema}/tables/${props.resource.name}/checks/${name}`)
    toast.add({ title: t('database.resourceConstraints.removed'), color: 'success' })
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceConstraints.removeError'))
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <SettingsSection :title="t('database.resourceConstraints.title')">
    <template #actions>
      <UButton
        :label="t('database.resourceConstraints.addConstraint')"
        icon="i-lucide-plus"
        size="sm"
        color="neutral"
        variant="outline"
        :disabled="detail?.canAlter === false"
        @click="openAdd"
      />
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

    <template v-else-if="detail">
      <p class="text-sm text-muted">
        {{ t('database.resourceConstraints.intro') }}
      </p>

      <UEmpty
        v-if="detail.checkConstraints.length === 0"
        variant="naked"
        size="sm"
        icon="i-lucide-shield-check"
        :title="t('database.resourceConstraints.empty')"
      />
      <UTable
        v-else
        sticky
        :data="detail.checkConstraints"
        :columns="COLUMNS"
      >
        <template #name-cell="{ row }">
          <span class="font-mono text-xs font-medium text-highlighted">{{ row.original.name }}</span>
        </template>
        <template #columns-cell="{ row }">
          {{ row.original.columns.join(', ') || '—' }}
        </template>
        <template #expression-cell="{ row }">
          <span class="font-mono text-xs">{{ row.original.expression }}</span>
          <span
            v-if="row.original.message"
            class="block font-mono text-xs"
          >"{{ row.original.message }}"</span>
        </template>
        <template #actions-cell="{ row }">
          <UPopover
            v-if="detail.canAlter"
            :open="editingMessage === row.original.name"
            @update:open="openMessage(row.original, $event)"
          >
            <UButton
              icon="i-lucide-message-square-text"
              size="xs"
              color="neutral"
              variant="ghost"
              :aria-label="t('database.resourceConstraints.messageAria', { name: row.original.name })"
            />
            <template #content>
              <div class="flex w-80 flex-col gap-3 p-3">
                <UFormField
                  :label="t('database.resourceConstraints.messageLabel')"
                  :description="t('database.resourceConstraints.messageDescription')"
                >
                  <UInput
                    v-model="messageDraft"
                    class="w-full"
                    @keydown.enter="saveMessage(row.original.name)"
                  />
                </UFormField>
                <div class="flex justify-end">
                  <UButton
                    :label="t('common.save')"
                    :loading="savingMessage"
                    @click="saveMessage(row.original.name)"
                  />
                </div>
              </div>
            </template>
          </UPopover>
          <ConfirmDeletePopover
            v-if="detail.canAlter"
            :title="t('database.resourceConstraints.deleteTitle')"
            :description="t('database.resourceConstraints.deleteDescription', { name: row.original.name })"
            @confirm="removeCheck(row.original.name)"
          >
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              :aria-label="t('database.resourceConstraints.deleteAria', { name: row.original.name })"
              :loading="removing === row.original.name"
            />
          </ConfirmDeletePopover>
        </template>
      </UTable>
    </template>

    <!-- Add check constraint -->
    <UModal
      v-model:open="isAddOpen"
      :title="t('database.resourceConstraints.modalTitle')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            :label="t('common.name')"
            :description="t('database.resourceConstraints.nameDescription')"
            required
          >
            <InputPgIdentifier
              v-model="checkName"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="t('database.resourceConstraints.expression')"
            :description="t('database.resourceConstraints.expressionDescription')"
            required
          >
            <div class="flex justify-end mb-1">
              <UPopover v-model:open="isBuilderOpen">
                <UButton
                  :label="t('database.resourceConstraints.build')"
                  icon="i-lucide-list-plus"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                />
                <template #content>
                  <div class="w-80 p-3">
                    <FilterConditionBuilder
                      :columns="columns"
                      :allow-variables="false"
                      @add="addCondition"
                    />
                  </div>
                </template>
              </UPopover>
            </div>
            <UTextarea
              v-model="checkExpression"
              class="w-full font-mono text-xs"
              :rows="4"
              :disabled="builtConditions.length > 0"
            />
          </UFormField>

          <UFormField
            v-if="builtConditions.length > 0"
            :label="t('database.resourceConstraints.builtConditions')"
            :description="t('database.resourceConstraints.builtConditionsDescription')"
          >
            <ul class="flex flex-col gap-1">
              <li
                v-for="(summary, index) in builtSummaries"
                :key="index"
                class="flex items-center justify-between gap-2 rounded-md border border-default px-2 py-1 text-sm"
              >
                <span class="truncate">
                  <span class="font-mono text-xs">{{ summary.field }}</span>
                  {{ summary.operatorLabel }}
                  <span
                    v-if="summary.value"
                    class="font-mono text-xs"
                  >{{ summary.value }}</span>
                </span>
                <UButton
                  icon="i-lucide-x"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :aria-label="t('database.resourceConstraints.removeCondition')"
                  @click="removeCondition(index)"
                />
              </li>
            </ul>
          </UFormField>

          <UFormField
            :label="t('database.resourceConstraints.errorMessage')"
            :description="t('database.resourceConstraints.errorMessageDescription')"
          >
            <UInput
              v-model="checkMessage"
              class="w-full"
            />
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
            @click="isAddOpen = false"
          />
          <UButton
            :label="t('common.add')"
            :loading="saving"
            :disabled="!canAdd"
            @click="addCheck"
          />
        </div>
      </template>
    </UModal>
  </SettingsSection>
</template>
