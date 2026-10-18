<script setup lang="ts">
/**
 * Organize menu's Edit on a group (Specification_Security.md §8.2): its name, its icon and its open icon (the pair
 * proposed from the icon), how it starts in the tree menu, Add subgroup (a root group) and Delete group - its entries move up to where it was,
 * nothing is deleted. The editor owns the tree and its autosave: Save hands the changes back.
 */
import type { MenuGroup, MenuGroupOpenState } from '~/types/app-menu'

const props = defineProps<{
  group: MenuGroup | null
  /** A root group may hold subgroups. */
  canHaveSubgroups: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  save: [change: { name: string, icon: string | null, iconOpen: string | null, openState: MenuGroupOpenState }]
  addSubgroup: []
  remove: []
}>()
const { t } = useI18n()

/** Lucide icons with an open counterpart - picking one proposes it as the open icon. */
const OPEN_PAIRS: Record<string, string> = {
  'i-lucide-folder': 'i-lucide-folder-open',
  'i-lucide-book': 'i-lucide-book-open',
  'i-lucide-lock': 'i-lucide-lock-open',
  'i-lucide-mail': 'i-lucide-mail-open',
  'i-lucide-package': 'i-lucide-package-open'
}

const draft = reactive({ name: '', icon: undefined as string | undefined, iconOpen: undefined as string | undefined, openState: 'DEFAULT' as MenuGroupOpenState })
const OPEN_STATE_ITEMS = computed<{ label: string, value: MenuGroupOpenState }[]>(() => [
  { label: t('settings.appMenuEditor.openStateDefault'), value: 'DEFAULT' },
  { label: t('settings.appMenuEditor.openStateOpen'), value: 'OPEN' },
  { label: t('settings.appMenuEditor.openStateClosed'), value: 'CLOSED' }
])
const confirmDelete = ref(false)
watch(open, (isOpen) => {
  if (!isOpen || !props.group) return
  draft.name = props.group.name
  draft.icon = props.group.icon ?? undefined
  draft.iconOpen = props.group.iconOpen ?? undefined
  draft.openState = props.group.openState ?? 'DEFAULT'
  confirmDelete.value = false
}, { immediate: true })

function setIcon(icon: string | undefined) {
  const before = draft.icon
  draft.icon = icon
  // Proposed only while the open icon is unset or was the previous icon's own pair.
  if (!draft.iconOpen || (before && draft.iconOpen === OPEN_PAIRS[before])) draft.iconOpen = icon ? OPEN_PAIRS[icon] : undefined
}
const nameValid = computed(() => draft.name.trim().length > 0)
function save() {
  if (!nameValid.value) return
  emit('save', { name: draft.name.trim().slice(0, 32), icon: draft.icon ?? null, iconOpen: draft.iconOpen ?? null, openState: draft.openState })
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.appMenuEditor.editGroupTitle')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('settings.appMenuEditor.groupName')"
          required
        >
          <UInput
            v-model="draft.name"
            maxlength="32"
            autofocus
            class="w-full"
            @keydown.enter="save"
          />
        </UFormField>
        <IconPickerField
          :model-value="draft.icon"
          :label="t('settings.appMenuEditor.groupIcon')"
          options="lucide"
          @update:model-value="setIcon"
        />
        <IconPickerField
          v-model="draft.iconOpen"
          :label="t('settings.appMenuEditor.groupIconOpen')"
          :help="t('settings.appMenuEditor.groupIconOpenHelp')"
          clearable
          options="lucide"
        />
        <UFormField :label="t('settings.appMenuEditor.openState')">
          <template #hint>
            <FieldHelp
              :text="t('settings.appMenuEditor.openStateHelp')"
              :label="t('settings.appMenuEditor.openState')"
            />
          </template>
          <USelect
            v-model="draft.openState"
            :items="OPEN_STATE_ITEMS"
            class="w-full"
          />
        </UFormField>
        <div v-if="canHaveSubgroups">
          <UButton
            :label="t('settings.appMenuEditor.newSubgroup')"
            icon="i-lucide-folder-plus"
            color="neutral"
            variant="outline"
            @click="emit('addSubgroup'); open = false"
          />
        </div>
        <USeparator />
        <div class="flex flex-col gap-1">
          <p class="text-sm font-medium text-error">
            {{ t('settings.appMenuEditor.deleteGroup') }}
          </p>
          <p class="text-sm text-muted">
            {{ t('settings.appMenuEditor.deleteGroupHelp') }}
          </p>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <div class="flex items-center gap-3">
          <UCheckbox
            v-model="confirmDelete"
            :label="t('common.confirm')"
          />
          <UButton
            :label="t('settings.appMenuEditor.deleteGroup')"
            color="error"
            variant="soft"
            :disabled="!confirmDelete"
            @click="emit('remove'); open = false"
          />
        </div>
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="outline"
            @click="open = false"
          />
          <UButton
            :label="t('common.save')"
            :disabled="!nameValid"
            @click="save"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
