<script setup lang="ts">
/**
 * The permission editor sidebar of a role's matrix (pages/roles/[id].vue)
 * - one cell = one (resource, action) grant: Allow/Deny, the columns it
 * covers, a row filter, payload checks (CREATE/UPDATE on a TABLE), and a
 * reference of the $-variables both filters accept. The page opens it
 * through `open(resource, action, existingGrant)` and refreshes its
 * matrix on `saved` (emitted after a save or a clear).
 */
import type { Resource } from '~/types/resource'
import {
  protectedFieldReason,
  type CatalogColumn,
  type FieldGrant,
  type Permission,
  type PermissionAction,
  type PermissionEffect,
  type PayloadCheck
} from '~/types/permission'

const props = defineProps<{ roleId: string }>()
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

// Same nested {field: {operator: value}} shape the Data API's own
// where[...] query params decode into (see parseFilter() in
// @totalbase/query-engine, the same parser that reads this back at
// request time) - not the flat {field, value, operator} shape this admin
// used to show here, which parseFilter can't actually read.
// Every leaf value in this grammar is a string, even for a boolean/numeric
// column - parseFilter() (@totalbase/query-engine) rejects a literal
// `true`/`123` outright ("Invalid value for operator") and expects
// coerceLiteral to turn "true"/"123" into the column's real type instead,
// the same way qs-decoded where[...] query params are always strings to
// begin with. `{"active":{"_eq":true}}` looks like the obvious example
// but actually fails - this is the form that works.
const WHERE_PLACEHOLDER = JSON.stringify({ active: { _eq: 'true' } })

// Reference for the new Variables tab below (Row filter/Payload check
// editors) - every $-prefixed token parseVariable()
// (@totalbase/query-engine/variables.ts) recognizes in a filter value.
// $INSERT.<field> deliberately left off: it's a mutation-payload-only
// variable (resolves to PostgreSQL's EXCLUDED.<field> in an upsert), not
// valid inside a where/payload-check filter - parseVariable itself rejects
// it there.
interface SupportedVariable {
  syntax: string
  description: string
}
// Icon-only tabs (switched from text labels) -
// items carry no `label` so UTabs renders just the icon; the tooltip
// text lives in EDITOR_TAB_LABELS instead, read by the #leading slot
// below, since reusing `label` for both would put the text back on the
// tab itself.
type EditorTabValue = 'grant' | 'where' | 'payloadChecks' | 'variables'
const EDITOR_TAB_LABELS = computed<Record<EditorTabValue, string>>(() => ({
  grant: t('users.permissionEditor.tabs.grant'),
  where: t('users.permissionEditor.tabs.where'),
  payloadChecks: t('users.permissionEditor.tabs.payloadChecks'),
  variables: t('users.permissionEditor.tabs.variables')
}))
const EDITOR_TABS = [
  { value: 'grant', icon: 'i-lucide-shield-check' },
  { value: 'where', icon: 'i-lucide-filter' },
  { value: 'variables', icon: 'i-lucide-braces' }
]
const EDITOR_TABS_WITH_PAYLOAD_CHECKS = [
  { value: 'grant', icon: 'i-lucide-shield-check' },
  { value: 'where', icon: 'i-lucide-filter' },
  { value: 'payloadChecks', icon: 'i-lucide-list-checks' },
  { value: 'variables', icon: 'i-lucide-braces' }
]

const SUPPORTED_VARIABLES = computed<SupportedVariable[]>(() => [
  { syntax: '$USER.<field>', description: t('users.permissionEditor.variables.user') },
  { syntax: '$CURRENT_TIMESTAMP', description: t('users.permissionEditor.variables.currentTimestamp') },
  { syntax: '$CURRENT_DATE', description: t('users.permissionEditor.variables.currentDate') },
  { syntax: '$CURRENT_TIME', description: t('users.permissionEditor.variables.currentTime') },
  { syntax: '$INTERVAL.<n><unit>', description: t('users.permissionEditor.variables.interval') },
  { syntax: '$PERIOD.<period>.<from|to>', description: t('users.permissionEditor.variables.period') }
])

// Error codes parseFilter() (@totalbase/query-engine) throws for a
// structurally malformed where - the server validates with the same
// function before persisting (see admin-permissions.ts). Anything else
// (network, permission, unrelated field) stays a plain toast.
const WHERE_VALIDATION_CODES = new Set(['INVALID_QUERY', 'INVALID_OPERATOR', 'INVALID_FIELD', 'INVALID_INTERVAL', 'INVALID_PERIOD', 'QUERY_DEPTH_LIMIT_EXCEEDED'])

// --- Editor drawer ---
const editorResource = ref<Resource | null>(null)
const editorAction = ref<PermissionAction | null>(null)
const isEditorOpen = computed({
  get: () => editorResource.value !== null,
  set: (open: boolean) => {
    if (!open) {
      editorResource.value = null
      editorAction.value = null
    }
  }
})
/** The cell's grant when opened - null for a cell with no grant yet (no "Clear grant" then). */
const existingGrant = ref<Permission | null>(null)
const draftEffect = ref<PermissionEffect>('ALLOW')
const draftFields = ref<string[]>([])
// Same order as the Columns checklist above (editorColumns), not
// whatever order they were checked in - a relation-traversal field (not
// in editorColumns, see allColumnsSelected's own comment) keeps its
// relative position by falling through to the end.
const orderedDraftFields = computed(() => {
  const columnOrder = new Map(editorColumns.value.map((col, index) => [col.name, index]))
  return [...draftFields.value].sort((a, b) => (columnOrder.get(a) ?? Infinity) - (columnOrder.get(b) ?? Infinity))
})
const draftWhereText = ref('')
const whereError = ref<string | null>(null)
const saving = ref(false)
const clearing = ref(false)

// "Payload checks" - only meaningful for CREATE/UPDATE on a TABLE (Admin_UI.md §11.3:
// VIEW is read-only, and DELETE/EXECUTE have no proposed
// values to check a business rule against). Each row is its own rule +
// optional label, same grammar as Row filter (including full _and/_or/
// _not nesting within one rule, for when a single combined message is
// what's wanted) - authored in its own modal (label, then a real Monaco
// editor for the rule) rather than a one-line input in this list, which
// has nowhere near enough room for anything but a trivial expression.
interface DraftPayloadCheck {
  ruleText: string
  label: string
}
const draftPayloadChecks = ref<DraftPayloadCheck[]>([])
const payloadChecksError = ref<string | null>(null)

const supportsPayloadChecks = computed(() =>
  editorResource.value?.type === 'TABLE' && (editorAction.value === 'CREATE' || editorAction.value === 'UPDATE')
)

function removePayloadCheck(index: number) {
  draftPayloadChecks.value.splice(index, 1)
}

// A short one-line preview for a rule's summary card - not meant to be
// readable JSON, just enough to tell rules apart at a glance without
// opening each one.
function payloadCheckSummary(ruleText: string): string {
  const trimmed = ruleText.trim().replace(/\s+/g, ' ')
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : (trimmed || t('users.permissionEditor.emptyRule'))
}

// --- Rule editor modal (Add Check / click a rule card to edit) ---
const editingRuleIndex = ref<number | null>(null)
const addingRule = ref(false)
const ruleModalLabel = ref('')
const ruleModalRuleText = ref('')
const ruleModalError = ref<string | null>(null)
const isRuleModalOpen = computed({
  get: () => editingRuleIndex.value !== null || addingRule.value,
  set: (open: boolean) => {
    if (!open) {
      editingRuleIndex.value = null
      addingRule.value = false
    }
  }
})

function openAddRule() {
  ruleModalLabel.value = ''
  ruleModalRuleText.value = ''
  ruleModalError.value = null
  editingRuleIndex.value = null
  addingRule.value = true
}
function openEditRule(index: number) {
  const target = draftPayloadChecks.value[index]!
  ruleModalLabel.value = target.label
  ruleModalRuleText.value = target.ruleText
  ruleModalError.value = null
  addingRule.value = false
  editingRuleIndex.value = index
}
function saveRuleModal() {
  if (!ruleModalRuleText.value.trim()) {
    ruleModalError.value = t('users.permissionEditor.ruleRequired')
    return
  }
  try {
    JSON.parse(ruleModalRuleText.value)
  } catch {
    ruleModalError.value = t('users.permissionEditor.invalidJson')
    return
  }
  ruleModalError.value = null
  const entry: DraftPayloadCheck = { ruleText: ruleModalRuleText.value, label: ruleModalLabel.value.trim() }
  if (editingRuleIndex.value !== null) {
    draftPayloadChecks.value[editingRuleIndex.value] = entry
  } else {
    draftPayloadChecks.value.push(entry)
  }
  isRuleModalOpen.value = false
}

// Never selectable - the server hard-blocks these regardless of any
// grant (the catalog's `protected`, from @totalbase/mutations' guardrails),
// so shown-but-disabled here is cosmetic clarity, not the actual
// enforcement; this check is defense-in-depth against a stray click.
function columnProtectedReason(name: string): string | undefined {
  const column = editorColumns.value.find(c => c.name === name)
  return column ? protectedFieldReason(column) : undefined
}

function toggleDraftField(name: string, checked: boolean) {
  if (columnProtectedReason(name)) return
  if (checked) {
    if (!draftFields.value.includes(name)) draftFields.value.push(name)
  } else {
    draftFields.value = draftFields.value.filter(f => f !== name)
  }
}

// "Select all" only adds/removes the direct columns this list actually
// shows - a relation-traversal field (e.g. "manager.first_name", Security.md §6.4)
// set some other way (API, or before this table's columns loaded)
// isn't in editorColumns and stays untouched either way, rather than
// getting silently wiped by unchecking this. Protected columns (see
// columnProtectedReason) are excluded from both directions - they can
// never count toward "all selected", and never get added.
const allColumnsSelected = computed({
  get: () => {
    const selectable = editorColumns.value.filter(c => !columnProtectedReason(c.name))
    return selectable.length > 0 && selectable.every(c => draftFields.value.includes(c.name))
  },
  set: (value: boolean) => {
    const directNames = new Set(editorColumns.value.filter(c => !columnProtectedReason(c.name)).map(c => c.name))
    draftFields.value = value
      ? [...new Set([...draftFields.value, ...directNames])]
      : draftFields.value.filter(f => !directNames.has(f))
  }
})

const { loadColumns } = useCatalogColumns()
const editorColumns = ref<CatalogColumn[]>([])
const columnsLoading = ref(false)

/** Opens the sidebar on one cell of the matrix, seeded with its current grant (or none). */
function open(resource: Resource, action: PermissionAction, existing: Permission | null) {
  editorResource.value = resource
  editorAction.value = action
  existingGrant.value = existing
  draftEffect.value = existing?.effect ?? 'ALLOW'
  draftFields.value = existing?.fields.map(f => f.field) ?? []
  draftWhereText.value = existing?.whereClause ? JSON.stringify(existing.whereClause, null, 2) : ''
  whereError.value = null
  draftPayloadChecks.value = existing?.payloadChecks.map(v => ({ ruleText: JSON.stringify(v.rule), label: v.label ?? '' })) ?? []
  payloadChecksError.value = null
  editorColumns.value = []

  if (resource.type === 'TABLE' || resource.type === 'VIEW') {
    columnsLoading.value = true
    loadColumns(resource)
      .then((cols) => { editorColumns.value = cols })
      .catch(() => { editorColumns.value = [] })
      .finally(() => { columnsLoading.value = false })
  }
}

async function savePermission() {
  if (!editorResource.value || !editorAction.value) return
  let where: Record<string, unknown> | null = null
  if (draftWhereText.value.trim()) {
    try {
      where = JSON.parse(draftWhereText.value)
    } catch {
      whereError.value = t('users.permissionEditor.invalidJson')
      return
    }
  }
  whereError.value = null

  let payloadChecks: PayloadCheck[] | undefined
  if (supportsPayloadChecks.value) {
    const rows = draftPayloadChecks.value.filter(v => v.ruleText.trim())
    const parsed: PayloadCheck[] = []
    for (const v of rows) {
      try {
        parsed.push({ rule: JSON.parse(v.ruleText), label: v.label.trim() || null })
      } catch {
        payloadChecksError.value = t('users.permissionEditor.invalidJsonRule', { rule: v.ruleText })
        return
      }
    }
    payloadChecks = parsed
  }
  payloadChecksError.value = null

  saving.value = true
  try {
    const fields: FieldGrant[] = orderedDraftFields.value.map(field => ({ field, effect: 'ALLOW' as const }))
    await api.put(`/roles/${props.roleId}/resources/${editorResource.value.id}/permissions/${editorAction.value}`, {
      data: {
        effect: draftEffect.value,
        fields,
        where,
        payloadChecks
      }
    })
    emit('saved')
    toast.add({ title: t('users.permissionEditor.saved'), color: 'success' })
    isEditorOpen.value = false
  } catch (err) {
    // The server structurally validates where/payload checks before
    // persisting (same parser the Data API itself reads them back with) -
    // surface that rejection right under the relevant field, not just as
    // a generic toast, so it reads the same as the JSON.parse failure
    // above. Can't tell from the error alone which of the two - where or
    // a payload check - it came from, so both fields show it; whichever
    // tab the admin is actually looking at is the one that matters.
    if (err instanceof AdminApiError && WHERE_VALIDATION_CODES.has(err.code)) {
      whereError.value = err.message
      payloadChecksError.value = err.message
    }
    notifyError(err, t('users.permissionEditor.saveError'))
  } finally {
    saving.value = false
  }
}

async function clearGrant() {
  if (!editorResource.value || !editorAction.value) return
  clearing.value = true
  try {
    await api.del(`/roles/${props.roleId}/resources/${editorResource.value.id}/permissions/${editorAction.value}`)
    emit('saved')
    toast.add({ title: t('users.permissionEditor.cleared'), color: 'success' })
    isEditorOpen.value = false
  } catch (err) {
    notifyError(err, t('users.permissionEditor.clearError'))
  } finally {
    clearing.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <div>
    <!-- Advanced editor - same botonera as the quick-effect popover above
    (Allow/Deny/Clear grant, color-coded, block-width) for visual
    consistency between the two entry points, but Allow/Deny only stage
    draftEffect here rather than committing immediately - Save is what
    persists effect+columns+where together. Save/Cancel live in #footer
    per AGENTS.md §25 "Sidebar footer actions"; Clear grant stays in
    #body since it acts on the record itself, not on this draft. -->
    <USlideover
      v-model:open="isEditorOpen"
      :title="editorResource ? `${editorResource.schema}.${editorResource.name} — ${editorAction}` : ''"
    >
      <template #body>
        <div
          v-if="editorResource"
          class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4"
        >
          <!-- FUNCTION has neither columns nor a row filter (EXECUTE
          only) - nothing to tab between, so it's just the Effect
          botonera. TABLE/VIEW get the two-tab layout below. -->
          <div
            v-if="editorResource.type !== 'TABLE' && editorResource.type !== 'VIEW'"
            class="flex flex-col gap-1"
          >
            <span class="text-sm font-medium">{{ t('users.permissionEditor.effect') }}</span>
            <UButton
              :label="t('users.permissionEditor.allow')"
              color="success"
              :variant="draftEffect === 'ALLOW' ? 'solid' : 'outline'"
              block
              @click="draftEffect = 'ALLOW'"
            />
            <UButton
              :label="t('users.permissionEditor.deny')"
              color="error"
              :variant="draftEffect === 'DENY' ? 'solid' : 'outline'"
              block
              @click="draftEffect = 'DENY'"
            />
            <UButton
              v-if="existingGrant"
              :label="t('users.permissionEditor.clearGrant')"
              color="neutral"
              variant="outline"
              :loading="clearing"
              block
              @click="clearGrant"
            />
          </div>

          <UTabs
            v-else
            :items="supportsPayloadChecks ? EDITOR_TABS_WITH_PAYLOAD_CHECKS : EDITOR_TABS"
            default-value="grant"
          >
            <template #leading="{ item }">
              <UTooltip :text="EDITOR_TAB_LABELS[item.value as EditorTabValue]">
                <UIcon
                  :name="item.icon!"
                  class="size-4"
                />
              </UTooltip>
              <span class="sr-only">{{ EDITOR_TAB_LABELS[item.value as EditorTabValue] }}</span>
            </template>
            <template #content="{ item }">
              <div
                v-if="item.value === 'grant'"
                class="flex flex-col gap-4 pt-4"
              >
                <div class="flex flex-col gap-1">
                  <span class="text-sm font-medium">{{ t('users.permissionEditor.effect') }}</span>
                  <UButton
                    :label="t('users.permissionEditor.allow')"
                    color="success"
                    :variant="draftEffect === 'ALLOW' ? 'solid' : 'outline'"
                    block
                    @click="draftEffect = 'ALLOW'"
                  />
                  <UButton
                    :label="t('users.permissionEditor.deny')"
                    color="error"
                    :variant="draftEffect === 'DENY' ? 'solid' : 'outline'"
                    block
                    @click="draftEffect = 'DENY'"
                  />
                  <UButton
                    v-if="existingGrant"
                    :label="t('users.permissionEditor.clearGrant')"
                    color="neutral"
                    variant="outline"
                    :loading="clearing"
                    block
                    @click="clearGrant"
                  />
                </div>

                <UFormField
                  :label="t('users.permissionEditor.columns')"
                  :description="t('users.permissionEditor.columnsHelp')"
                >
                  <UEmpty
                    v-if="columnsLoading"
                    loading
                    variant="naked"
                    size="sm"
                  />
                  <p
                    v-else-if="editorColumns.length === 0"
                    class="text-xs text-muted"
                  >
                    {{ t('users.permissionEditor.noColumns') }}
                  </p>
                  <template v-else>
                    <label class="flex items-center justify-between gap-2 py-1 text-sm cursor-pointer">
                      <span>{{ t('users.permissionEditor.selectAll') }}</span>
                      <USwitch
                        v-model="allColumnsSelected"
                        :aria-label="t('users.permissionEditor.selectAllColumns')"
                      />
                    </label>
                    <div class="max-h-[28rem] overflow-y-auto border border-default rounded-lg divide-y divide-default my-2">
                      <label
                        v-for="col in editorColumns"
                        :key="col.name"
                        class="flex items-center gap-2 px-3 py-1.5 text-sm"
                        :class="columnProtectedReason(col.name) ? 'opacity-60' : 'cursor-pointer hover:bg-elevated'"
                      >
                        <UCheckbox
                          :model-value="draftFields.includes(col.name)"
                          :disabled="!!columnProtectedReason(col.name)"
                          :aria-label="col.name"
                          @update:model-value="(checked: boolean | 'indeterminate') => toggleDraftField(col.name, checked === true)"
                        />
                        <span class="font-mono text-xs">{{ col.name }}</span>
                        <UTooltip
                          v-if="columnProtectedReason(col.name)"
                          :text="t(columnProtectedReason(col.name)!)"
                        >
                          <UIcon
                            name="i-lucide-lock"
                            class="size-3.5 text-muted"
                          />
                        </UTooltip>
                      </label>
                    </div>
                  </template>
                  <p class="text-xs text-muted mt-1">
                    {{ t('users.permissionEditor.fields', { fields: orderedDraftFields.length > 0 ? orderedDraftFields.join(', ') : t('users.permissionEditor.noneSelected') }) }}
                  </p>
                </UFormField>
              </div>

              <div
                v-else-if="item.value === 'where'"
                class="pt-4"
              >
                <WhereField
                  v-model="draftWhereText"
                  :label="t('users.permissionEditor.rowFilter')"
                  :description="t('users.permissionEditor.rowFilterHelp', { example: WHERE_PLACEHOLDER })"
                  :error="whereError"
                  :columns="editorColumns"
                  min-height="28rem"
                />
              </div>

              <div
                v-else-if="item.value === 'payloadChecks'"
                class="flex flex-col gap-3 pt-4"
              >
                <p class="text-xs text-muted">
                  {{ t('users.permissionEditor.payloadChecksHelp') }}
                </p>
                <button
                  v-for="(check, index) in draftPayloadChecks"
                  :key="index"
                  type="button"
                  class="flex items-center justify-between gap-2 border border-default rounded-lg p-2 text-left hover:bg-elevated"
                  @click="openEditRule(index)"
                >
                  <div class="flex flex-col min-w-0">
                    <span
                      class="text-sm truncate"
                      :class="check.label ? 'font-medium' : 'text-muted italic'"
                    >
                      {{ check.label || t('users.permissionEditor.untitledCheck') }}
                    </span>
                    <span class="font-mono text-xs text-muted truncate">{{ payloadCheckSummary(check.ruleText) }}</span>
                  </div>
                  <UButton
                    icon="i-lucide-trash-2"
                    size="xs"
                    color="error"
                    variant="ghost"
                    class="shrink-0"
                    :aria-label="check.label ? t('users.permissionEditor.removeNamed', { name: check.label }) : t('users.permissionEditor.removeCheck')"
                    @click.stop="removePayloadCheck(index)"
                  />
                </button>
                <p
                  v-if="draftPayloadChecks.length === 0"
                  class="text-xs text-muted"
                >
                  {{ t('users.permissionEditor.noPayloadChecks') }}
                </p>
                <p
                  v-if="payloadChecksError"
                  class="text-xs text-error"
                >
                  {{ payloadChecksError }}
                </p>
                <UButton
                  :label="t('users.permissionEditor.addCheck')"
                  icon="i-lucide-plus"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  class="w-fit"
                  @click="openAddRule"
                />
              </div>

              <div
                v-else
                class="flex flex-col gap-3 pt-4"
              >
                <p class="text-xs text-muted">
                  {{ t('users.permissionEditor.variablesHelp') }}
                </p>
                <div class="border border-default rounded-lg divide-y divide-default">
                  <div
                    v-for="variable in SUPPORTED_VARIABLES"
                    :key="variable.syntax"
                    class="flex flex-col gap-0.5 px-3 py-2"
                  >
                    <span class="font-mono text-xs font-medium">{{ variable.syntax }}</span>
                    <span class="text-xs text-muted">{{ variable.description }}</span>
                  </div>
                </div>
              </div>
            </template>
          </UTabs>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="isEditorOpen = false"
          />
          <UButton
            :label="t('common.save')"
            :loading="saving"
            @click="savePermission"
          />
        </div>
      </template>
    </USlideover>

    <!-- Payload check editor - opened from within the Advanced sidebar
    above (same nesting as users/index.vue's delete confirmation opening
    from inside its detail USlideover). Its own modal rather than an
    inline row: a rule's JSON can be a
    full _and/_or/_not tree, which needs real room to write - Monaco, not
    a one-line input. -->
    <UModal
      v-model:open="isRuleModalOpen"
      :title="editingRuleIndex !== null ? t('users.permissionEditor.editCheck') : t('users.permissionEditor.newCheck')"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            :label="t('users.permissionEditor.errorMessage')"
            :description="t('users.permissionEditor.errorMessageHelp')"
          >
            <UInput
              v-model="ruleModalLabel"
              class="w-full"
            />
          </UFormField>
          <WhereField
            v-model="ruleModalRuleText"
            :label="t('users.permissionEditor.check')"
            :description="t('users.permissionEditor.checkHelp', { example: WHERE_PLACEHOLDER })"
            :error="ruleModalError"
            :columns="editorColumns"
            min-height="10rem"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="isRuleModalOpen = false"
          />
          <UButton
            :label="t('common.save')"
            @click="saveRuleModal"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
