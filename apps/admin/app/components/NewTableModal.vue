<script setup lang="ts">
import { useApiErrorMessage } from '~/utils/api-error-message'
import type { RelationDetail } from '~/types/schema'
/**
 * New Table (Administration.md §3.4: a minimal wizard, not a
 * full schema designer - name, description, PK strategy, nothing else; the
 * rest of the columns get added afterward from the table's own detail
 * page). TableDrawer is the EDIT side only (columns/PK/FK/CHECK/indexes/
 * data preview - out of scope here).
 *
 * PK type list is the user's own flattened restatement of the spec's 4
 * strategies (UUID / Auto-increment / Manual integer / Manual text) into
 * 5 concrete Postgres types - Serial and BigSerial broken out as their
 * own explicit choices rather than one "Auto-increment" bucket.
 */
const open = defineModel<boolean>('open', { required: true })
/** The schema it opens on - the one the Database panel is showing. */
const props = defineProps<{ defaultSchema?: string }>()
const emit = defineEmits<{ created: [resource: { schema: string, name: string, id: string | null, oid: number | null }] }>()

const api = useAdminApi()
const resourcesApi = useResourcesApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()

const { schemaNames: schemas } = useSchemasList()

type PkType = 'uuid' | 'serial' | 'bigserial' | 'integer' | 'varchar'
const PK_TYPES: { value: PkType, label: string }[] = [
  { value: 'uuid', label: 'UUID' },
  { value: 'serial', label: 'Serial' },
  { value: 'bigserial', label: 'BigSerial' },
  { value: 'integer', label: 'Integer' },
  { value: 'varchar', label: 'Varchar' }
]
/** Postgres data type + DEFAULT expression for each PK type - only UUID needs a default, Serial/BigSerial imply their own via the pseudo-type itself, Integer/Varchar are manually supplied by whoever writes the row. */
function pkTypeToColumn(type: PkType): { dataType: string, default?: string } {
  switch (type) {
    case 'uuid': return { dataType: 'uuid', default: 'gen_random_uuid()' }
    case 'serial': return { dataType: 'serial' }
    case 'bigserial': return { dataType: 'bigserial' }
    case 'integer': return { dataType: 'integer' }
    case 'varchar': return { dataType: 'varchar(255)' }
  }
}

// --- A junction table (Administration.md §3.4): a many-to-many
// relation modelled as an ordinary table - `id`, one foreign key per related
// table (ON DELETE CASCADE), a UNIQUE over them. Two or three tables, the
// same one twice for a self-relation. ---
type TableKind = 'TABLE' | 'JUNCTION'
const KINDS = computed(() => [
  { label: t('database.newTableModal.kindTable'), value: 'TABLE', description: t('database.newTableModal.kindTableDescription') },
  { label: t('database.newTableModal.kindJunction'), value: 'JUNCTION', description: t('database.newTableModal.kindJunctionDescription') }
])
const kind = ref<TableKind>('TABLE')
interface RelatedPick { oid: number | undefined, column: string }
const related = ref<RelatedPick[]>([])
const { tables: catalogTables } = useCatalogTablesList()
const tableItems = computed(() => (catalogTables.value ?? []).map(t => ({ label: t.schema === 'public' ? t.name : `${t.schema}.${t.name}`, value: t.oid })))
function tableOf(oid: number | undefined) {
  return (catalogTables.value ?? []).find(t => t.oid === oid)
}

const schema = ref('public')
const name = ref('')
/** The proposed name - the related tables' names joined - until the name is edited by hand. */
const nameEdited = ref(false)
watch(related, (picks) => {
  if (kind.value !== 'JUNCTION') return
  // Each column is named after its table; the same table twice needs its own names.
  for (const pick of picks) {
    if (!pick.column && pick.oid !== undefined) pick.column = tableOf(pick.oid)?.name ?? ''
  }
  const names = picks.map(p => tableOf(p.oid)?.name).filter((n): n is string => !!n)
  if (!nameEdited.value && names.length > 0) name.value = names.join('_')
}, { deep: true })
function onNameInput(value: string) {
  name.value = value
  nameEdited.value = true
}
const junctionColumns = computed(() => related.value.map(p => p.column.trim()))
const junctionValid = computed(() => related.value.length >= 2 && related.value.every(p => p.oid !== undefined && p.column.trim())
  && new Set(junctionColumns.value).size === junctionColumns.value.length && !junctionColumns.value.includes('id'))
const description = ref('')
const pkName = ref('id')
const pkType = ref<PkType>('uuid')
const saving = ref(false)
const formError = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    schema.value = props.defaultSchema ?? 'public'
    name.value = ''
    description.value = ''
    pkName.value = 'id'
    pkType.value = 'uuid'
    formError.value = null
    kind.value = 'TABLE'
    related.value = [{ oid: undefined, column: '' }, { oid: undefined, column: '' }]
    nameEdited.value = false
  }
})

const valid = computed(() => name.value.trim().length > 0 && (kind.value === 'JUNCTION' ? junctionValid.value : pkName.value.trim().length > 0))

/** The junction's columns: `id`, then one foreign key per related table, to its single-column primary key. */
async function junctionBody() {
  const columns: Record<string, unknown>[] = [{ name: 'id', dataType: 'uuid', nullable: false, default: 'gen_random_uuid()', primaryKey: true }]
  for (const pick of related.value) {
    const table = tableOf(pick.oid)!
    const { data: detail } = await api.get<RelationDetail>(`/catalog/table/${table.oid}`)
    if (detail.primaryKey.length !== 1) throw new Error(t('database.newTableModal.noSingleKey', { table: table.name }))
    const key = detail.primaryKey[0]!
    const dataType = detail.columns.find(c => c.name === key)!.dataType
    columns.push({
      name: pick.column.trim(),
      dataType,
      nullable: false,
      foreignKey: { targetSchema: table.schema, targetTable: table.name, targetColumn: key, onDelete: 'CASCADE' }
    })
  }
  return { name: name.value.trim(), columns, uniques: [junctionColumns.value] }
}

async function create() {
  if (!valid.value) return
  saving.value = true
  formError.value = null
  try {
    const pkColumn = pkTypeToColumn(pkType.value)
    const body = kind.value === 'JUNCTION'
      ? await junctionBody()
      : {
          name: name.value.trim(),
          columns: [{
            name: pkName.value.trim(),
            dataType: pkColumn.dataType,
            nullable: false,
            default: pkColumn.default,
            primaryKey: true
          }]
        }
    const { data } = await api.post<{ schema: string, name: string, id: string | null, oid: number | null }>(
      `/schema/${schema.value}/tables`,
      { data: body }
    )

    // createTable can't set a description atomically (there's no
    // resources row - and so no id to PATCH - until catalog
    // refresh reconciles the new table into it) - a best-effort follow-up.
    if (description.value.trim()) {
      try {
        const created = await resourcesApi.list({ schema: schema.value, type: 'TABLE' })
        const resource = created.find(r => r.name === name.value.trim())
        if (resource) await api.patch(`/resources/${resource.id}`, { data: { description: description.value.trim() } })
      } catch {
        // Best-effort - the table exists regardless.
      }
    }

    toast.add({ title: t('database.newTableModal.created'), color: 'success' })
    open.value = false
    emit('created', data)
  } catch (err) {
    formError.value = err instanceof AdminApiError ? errorMessage(err) : err instanceof Error ? err.message : t('database.newTableModal.createFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('database.newTableModal.title')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UAlert
          v-if="formError"
          color="error"
          variant="subtle"
          :title="formError"
        />

        <URadioGroup
          v-model="kind"
          :items="KINDS"
          :aria-label="t('database.newTableModal.kind')"
        />

        <div
          v-if="kind === 'JUNCTION'"
          class="flex flex-col gap-3"
        >
          <p class="text-sm text-muted">
            {{ t('database.newTableModal.junctionHelp') }}
          </p>
          <div
            v-for="(pick, index) in related"
            :key="index"
            class="flex items-end gap-2 max-md:flex-col max-md:items-stretch"
          >
            <UFormField
              :label="t('database.newTableModal.tableN', { n: index + 1 })"
              class="flex-1"
            >
              <USelectMenu
                v-model="pick.oid"
                :items="tableItems"
                value-key="value"
                :aria-label="t('database.newTableModal.tableN', { n: index + 1 })"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('database.newTableModal.column')"
              class="flex-1"
            >
              <InputPgIdentifier
                v-model="pick.column"
                class="w-full"
                :aria-label="t('database.newTableModal.columnN', { n: index + 1 })"
              />
            </UFormField>
            <UButton
              v-if="related.length > 2"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              :aria-label="t('database.newTableModal.removeTableN', { n: index + 1 })"
              @click="related.splice(index, 1)"
            />
          </div>
          <div>
            <UButton
              v-if="related.length < 3"
              :label="t('database.newTableModal.addThirdTable')"
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="outline"
              @click="related.push({ oid: undefined, column: '' })"
            />
          </div>
          <p
            v-if="related.every(p => p.oid !== undefined && p.column.trim()) && !junctionValid"
            class="text-xs text-error"
          >
            {{ t('database.newTableModal.columnsUnique') }}
          </p>
        </div>

        <UFormField
          :label="t('common.name')"
          :description="kind === 'JUNCTION' ? t('database.newTableModal.nameJunctionDescription') : t('database.newTableModal.nameDescription')"
        >
          <InputPgIdentifier
            :model-value="name"
            class="w-full"
            autofocus
            @update:model-value="onNameInput"
          />
        </UFormField>

        <UFormField
          :label="t('common.description')"
          :description="t('database.newTableModal.descriptionHelp')"
        >
          <UTextarea
            v-model="description"
            :rows="2"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('database.newTableModal.schema')">
          <USelect
            v-model="schema"
            :items="schemas ?? ['public']"
            class="w-full"
          />
        </UFormField>

        <SettingsSection
          v-if="kind === 'TABLE'"
          :title="t('database.newTableModal.primaryKey')"
        >
          <UFormField
            :label="t('common.name')"
            :description="t('database.newTableModal.pkNameDescription')"
          >
            <InputPgIdentifier
              v-model="pkName"
              class="w-full"
            />
          </UFormField>

          <UFormField
            :label="t('common.type')"
            :description="t('database.newTableModal.pkTypeDescription')"
          >
            <USelect
              v-model="pkType"
              :items="PK_TYPES"
              class="w-full"
            />
          </UFormField>
        </SettingsSection>

        <div class="flex justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          />
          <UButton
            :label="t('common.create')"
            :loading="saving"
            :disabled="!valid"
            @click="create"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
