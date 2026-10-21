<script setup lang="ts">
/**
 * Settings › Columns › "Add columns…" (DataViews.md §4.1): the source table's columns and, under each
 * foreign key, the columns of the table it points at (a related column, `brand.country`, read only - one hop, a
 * table the Data API exposes for reading). A USlideover beside the columns table, so the DataView's columns stay in
 * sight. What the DataView has already shows checked and locked - hidden ones marked so; this panel only adds,
 * a column leaves through its row's Remove. A foreign key's group loads its table's columns when opened.
 */
import { columnTitle } from '@totalbase/tb-catalog'
import type { DataView, DataViewField } from '~/types/dataview'
import type { RelationDetail } from '~/types/schema'
import { humanizeColumnName } from '~/utils/humanize-column-name'

const props = defineProps<{
  dataview: DataView
  /** Its COLUMN and RELATED fields. */
  columnFields: DataViewField[]
  /** The source table's catalog - null while it loads. */
  relationDetail: RelationDetail | null
  saving?: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ add: [paths: string[]] }>()

const api = useAdminApi()
const { t } = useI18n()
const { resources: resourceList } = useResourcesList()

interface Option { path: string, name: string, title: string, dataType: string }

/** Already in the DataView, by path - shown checked and locked; `hidden` when it's there but not shown. */
const inView = computed(() => new Map(props.columnFields.filter(f => f.columnName).map(f => [f.columnName!, { hidden: !f.visible }])))
const selected = ref<Set<string>>(new Set())
const query = ref('')
const expanded = ref<Set<string>>(new Set())

watch(open, (isOpen) => {
  if (!isOpen) return
  selected.value = new Set()
  query.value = ''
  expanded.value = new Set()
})

/** A column's title - its table column's, else its name humanized (DataViews.md §15). */
function titleOf(resourceId: string | undefined, name: string): string {
  const presentation = resourceId ? props.dataview.columnPresentation?.[resourceId]?.[name] : undefined
  return columnTitle(presentation, humanizeColumnName(name))
}

const ownOptions = computed<Option[]>(() => (props.relationDetail?.columns ?? [])
  .filter(c => !c.protected)
  .map(c => ({ path: c.name, name: c.name, title: titleOf(props.dataview.sourceResource ?? undefined, c.name), dataType: c.dataType })))

interface Group { fk: string, table: string, resourceId: string | null, available: boolean }
const groups = computed<Group[]>(() => (props.relationDetail?.relations ?? []).map((relation) => {
  const target = resourceList.value.find(r => r.schema === relation.targetSchema && r.name === relation.targetTable)
  const available = Boolean(target && target.status === 'ACTIVE' && target.exposedMethods.includes('GET'))
  return { fk: relation.sourceColumn, table: relation.targetTable, resourceId: target?.id ?? null, available }
}))

/** Each foreign key's target columns, loaded once when its group opens; null: couldn't be read. */
const targetColumns = reactive<Record<string, Option[] | null>>({})
async function loadGroup(group: Group) {
  if (targetColumns[group.fk] !== undefined || !group.available) return
  const target = resourceList.value.find(r => r.id === group.resourceId)
  if (!target) return
  try {
    const { data } = await api.get<RelationDetail>(`/catalog/${target.type === 'VIEW' ? 'view' : 'table'}/${target.postgresOid}`)
    targetColumns[group.fk] = data.columns
      .filter(c => !c.protected)
      .map(c => ({ path: `${group.fk}.${c.name}`, name: c.name, title: titleOf(target.id, c.name), dataType: c.dataType }))
  } catch {
    targetColumns[group.fk] = null
  }
}
function toggleGroup(group: Group) {
  const next = new Set(expanded.value)
  if (next.has(group.fk)) next.delete(group.fk)
  else {
    next.add(group.fk)
    void loadGroup(group)
  }
  expanded.value = next
}

/** A search shows every group open, so a match under a foreign key is never out of sight. */
const searching = computed(() => query.value.trim().length > 0)
watch(searching, (on) => {
  if (on) for (const group of groups.value) void loadGroup(group)
})
function matches(option: Option): boolean {
  const q = query.value.trim().toLowerCase()
  return !q || option.title.toLowerCase().includes(q) || option.name.toLowerCase().includes(q)
}
const visibleOwn = computed(() => ownOptions.value.filter(matches))
function visibleIn(group: Group): Option[] {
  return (targetColumns[group.fk] ?? []).filter(matches)
}
function isOpenGroup(group: Group): boolean {
  return searching.value || expanded.value.has(group.fk)
}

function setChecked(path: string, value: boolean) {
  if (inView.value.has(path)) return
  const next = new Set(selected.value)
  if (value) next.add(path)
  else next.delete(path)
  selected.value = next
}
/** What "All" would add in a list - what's shown and not in the DataView yet. */
function addable(options: Option[]): Option[] {
  return options.filter(o => !inView.value.has(o.path))
}
function allChecked(options: Option[]): boolean {
  const rest = addable(options)
  return rest.length > 0 && rest.every(o => selected.value.has(o.path))
}
function setAll(options: Option[], value: boolean) {
  const next = new Set(selected.value)
  for (const o of addable(options)) {
    if (value) next.add(o.path)
    else next.delete(o.path)
  }
  selected.value = next
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :title="t('designer.dataViewAddColumns.title')"
    :description="t('designer.dataViewAddColumns.intro')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UInput
          v-model="query"
          icon="i-lucide-search"
          :placeholder="t('designer.dataViewAddColumns.search')"
          :aria-label="t('designer.dataViewAddColumns.search')"
          class="w-full"
        />

        <UEmpty
          v-if="!relationDetail"
          loading
          variant="naked"
          size="sm"
        />
        <template v-else>
          <section class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium text-muted uppercase">
                {{ dataview.sourceResourceName }}
              </p>
              <UCheckbox
                v-if="addable(visibleOwn).length"
                :model-value="allChecked(visibleOwn)"
                :label="t('designer.dataViewAddColumns.all')"
                size="sm"
                @update:model-value="(v) => setAll(visibleOwn, v === true)"
              />
            </div>
            <UCheckbox
              v-for="option in visibleOwn"
              :key="option.path"
              :model-value="inView.has(option.path) || selected.has(option.path)"
              :disabled="inView.has(option.path)"
              @update:model-value="(v) => setChecked(option.path, v === true)"
            >
              <template #label>
                <span class="font-medium text-highlighted">{{ option.title }}</span>
                <UBadge
                  v-if="inView.get(option.path)?.hidden"
                  :label="t('designer.dataViewAddColumns.hidden')"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  class="ml-2"
                />
              </template>
              <template #description>
                <span class="font-mono">{{ option.name }}</span> · {{ option.dataType }}
              </template>
            </UCheckbox>
            <p
              v-if="!visibleOwn.length"
              class="text-xs text-muted"
            >
              {{ t('designer.dataViewAddColumns.noMatch') }}
            </p>
          </section>

          <section
            v-for="group in groups"
            :key="group.fk"
            class="flex flex-col gap-1 border-t border-default pt-3"
          >
            <div class="flex items-center justify-between gap-2">
              <button
                type="button"
                class="flex min-w-0 items-center gap-2 text-left text-sm"
                :aria-expanded="isOpenGroup(group)"
                @click="toggleGroup(group)"
              >
                <UIcon
                  :name="isOpenGroup(group) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="size-4 shrink-0 text-muted"
                />
                <UIcon
                  name="i-lucide-link"
                  class="size-4 shrink-0 text-muted"
                />
                <span class="truncate font-medium text-highlighted">{{ group.fk }} → {{ group.table }}</span>
              </button>
              <UCheckbox
                v-if="isOpenGroup(group) && addable(visibleIn(group)).length"
                :model-value="allChecked(visibleIn(group))"
                :label="t('designer.dataViewAddColumns.all')"
                size="sm"
                @update:model-value="(v) => setAll(visibleIn(group), v === true)"
              />
            </div>
            <div
              v-if="isOpenGroup(group)"
              class="ml-6 flex flex-col gap-1 border-l border-default pl-3"
            >
              <p
                v-if="!group.available || targetColumns[group.fk] === null"
                class="text-xs text-muted"
              >
                {{ t('designer.dataViewAddColumns.unavailable') }}
              </p>
              <UEmpty
                v-else-if="targetColumns[group.fk] === undefined"
                loading
                variant="naked"
                size="sm"
              />
              <template v-else>
                <UCheckbox
                  v-for="option in visibleIn(group)"
                  :key="option.path"
                  :model-value="inView.has(option.path) || selected.has(option.path)"
                  :disabled="inView.has(option.path)"
                  @update:model-value="(v) => setChecked(option.path, v === true)"
                >
                  <template #label>
                    <span class="font-medium text-highlighted">{{ option.title }}</span>
                    <UBadge
                      v-if="inView.get(option.path)?.hidden"
                      :label="t('designer.dataViewAddColumns.hidden')"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      class="ml-2"
                    />
                  </template>
                  <template #description>
                    <span class="font-mono">{{ option.name }}</span> · {{ option.dataType }}
                  </template>
                </UCheckbox>
                <p
                  v-if="!visibleIn(group).length"
                  class="text-xs text-muted"
                >
                  {{ t('designer.dataViewAddColumns.noMatch') }}
                </p>
              </template>
            </div>
          </section>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
        <UButton
          :label="selected.size ? t('designer.dataViewAddColumns.addCount', { n: selected.size }) : t('common.add')"
          icon="i-lucide-plus"
          :loading="saving"
          :disabled="!selected.size"
          @click="emit('add', [...selected])"
        />
      </div>
    </template>
  </USlideover>
</template>
