<script setup lang="ts">
/**
 * The editor's tabs (Dashboards.md §7.2, D7): the strip over the canvas - one grid per tab - with Add
 * tab, and the open tab's "⋮" (Rename…, Remove…). Removing a tab that holds widgets moves them to another first
 * (the server keeps a tab with widgets, DASHBOARD_TAB_NOT_EMPTY). The host saves; this only asks.
 */
import type { DashboardTab } from '~/types/dashboard'

const props = defineProps<{
  tabs: DashboardTab[]
  readOnly: boolean
  /** How many widgets each tab holds - a widget without one counts for the first. */
  counts: Record<string, number>
}>()
const active = defineModel<string | undefined>({ required: true })
const emit = defineEmits<{
  add: [label: string]
  rename: [value: string, label: string]
  remove: [value: string, moveTo: string | null]
}>()
const { t } = useI18n()

const items = computed(() => props.tabs.map(tab => ({ label: tab.label, value: tab.value, ...(tab.icon && { icon: tab.icon }) })))
const current = computed(() => props.tabs.find(tab => tab.value === active.value))

const adding = ref(false)
const newLabel = ref('')
function add() {
  const label = newLabel.value.trim()
  if (!label) return
  emit('add', label)
  newLabel.value = ''
  adding.value = false
}

const renaming = ref(false)
const renameLabel = ref('')
function startRename() {
  renameLabel.value = current.value?.label ?? ''
  renaming.value = true
}
function rename() {
  const label = renameLabel.value.trim()
  if (!label || !current.value) return
  emit('rename', current.value.value, label)
  renaming.value = false
}

const removing = ref(false)
const moveTo = ref<string | undefined>(undefined)
const held = computed(() => (current.value ? props.counts[current.value.value] ?? 0 : 0))
const others = computed(() => props.tabs.filter(tab => tab.value !== current.value?.value).map(tab => ({ label: tab.label, value: tab.value })))
function startRemove() {
  moveTo.value = others.value[0]?.value
  removing.value = true
}
function remove() {
  if (!current.value) return
  emit('remove', current.value.value, held.value > 0 ? moveTo.value ?? null : null)
  removing.value = false
}

const menu = computed(() => [[
  { label: t('dashboards.tabs.rename'), icon: 'i-lucide-pencil', onSelect: startRename },
  { label: t('dashboards.tabs.remove'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: startRemove }
]])
</script>

<template>
  <div class="flex min-w-0 items-center gap-1">
    <div
      v-if="items.length"
      class="min-w-0 overflow-x-auto"
    >
      <UTabs
        v-model="active"
        :items="items"
        :content="false"
        variant="link"
        class="w-max"
      />
    </div>
    <template v-if="!readOnly">
      <UPopover v-model:open="adding">
        <UButton
          icon="i-lucide-plus"
          :label="items.length ? undefined : t('dashboards.tabs.add')"
          :aria-label="t('dashboards.tabs.add')"
          color="neutral"
          variant="ghost"
          size="sm"
        />
        <template #content>
          <form
            class="flex w-72 flex-col gap-3 p-3"
            @submit.prevent="add"
          >
            <UFormField
              :label="t('dashboards.tabs.label')"
              :description="items.length ? undefined : t('dashboards.tabs.firstHelp')"
            >
              <UInput
                v-model="newLabel"
                autofocus
                maxlength="32"
                class="w-full"
              />
            </UFormField>
            <UButton
              type="submit"
              :label="t('dashboards.tabs.add')"
              :disabled="!newLabel.trim()"
              class="self-end"
            />
          </form>
        </template>
      </UPopover>
      <UDropdownMenu
        v-if="current"
        :items="menu"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          :aria-label="t('dashboards.tabs.actions', { tab: current.label })"
          color="neutral"
          variant="ghost"
          size="sm"
        />
      </UDropdownMenu>
    </template>

    <UModal
      v-model:open="renaming"
      :title="t('dashboards.tabs.renameTitle')"
    >
      <template #body>
        <form
          id="dashboard-tab-rename"
          @submit.prevent="rename"
        >
          <UFormField :label="t('dashboards.tabs.label')">
            <UInput
              v-model="renameLabel"
              autofocus
              maxlength="32"
              class="w-full"
            />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="renaming = false"
          />
          <UButton
            type="submit"
            form="dashboard-tab-rename"
            :label="t('common.save')"
            :disabled="!renameLabel.trim()"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="removing"
      :title="t('dashboards.tabs.removeTitle', { tab: current?.label ?? '' })"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted">
            {{ held > 0 ? t('dashboards.tabs.removeHolds', held) : t('dashboards.tabs.removeEmpty') }}
          </p>
          <UFormField
            v-if="held > 0 && others.length"
            :label="t('dashboards.tabs.moveTo')"
          >
            <USelect
              v-model="moveTo"
              :items="others"
              class="w-full"
            />
          </UFormField>
          <p
            v-else-if="held > 0"
            class="text-sm text-muted"
          >
            {{ t('dashboards.tabs.lastTab') }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            @click="removing = false"
          />
          <UButton
            :label="held > 0 && others.length ? t('dashboards.tabs.moveAndRemove') : t('dashboards.tabs.remove')"
            color="error"
            @click="remove"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
