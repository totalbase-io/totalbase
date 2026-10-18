<script setup lang="ts">
/**
 * Organize menu's Edit on a DataView or a dashboard (Specification_Security.md §8.2): how it shows in the menu -
 * its label there (empty: its name), its description (the tooltip), its icon and color. They are its own fields,
 * the same as its settings', saved at once and live, no publish. Open settings leads there; Remove from the menu
 * takes it out (EMBEDDED_ONLY) without deleting it - Organize menu's Hidden list puts it back.
 */
import type { MenuObject } from '~/types/app-menu'
import type { RoleColor } from '~/types/permission'

const props = defineProps<{ object: MenuObject | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  saved: [object: MenuObject]
  remove: []
  openSettings: []
}>()
const { t } = useI18n()
const api = useAdminApi()
const notifyError = useErrorToast()

const scope = ref<'LISTED' | 'EMBEDDED_ONLY'>('LISTED')
const menuLabel = ref<string | null>(null)
const description = ref<string | null>(null)
const icon = ref<string | undefined>(undefined)
const color = ref<RoleColor | undefined>(undefined)
const saving = ref(false)
watch(open, (isOpen) => {
  if (!isOpen || !props.object) return
  menuLabel.value = props.object.menuLabel
  description.value = props.object.description
  icon.value = props.object.icon ?? undefined
  color.value = (props.object.color as RoleColor | null) ?? undefined
}, { immediate: true })

async function save() {
  const object = props.object
  if (!object) return
  saving.value = true
  try {
    const data = { menuLabel: menuLabel.value?.trim() || null, description: description.value?.trim() || null, icon: icon.value ?? null, color: color.value ?? null }
    await api.patch(`/${object.kind === 'DATAVIEW' ? 'dataviews' : 'dashboards'}/${object.id}`, { data })
    emit('saved', { ...object, ...data })
    open.value = false
  } catch (err) {
    notifyError(err, t('settings.appMenuEditor.labelError'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.appMenuEditor.editItemTitle', { name: object?.name ?? '' })"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <AppPresentationFields
          v-model:scope="scope"
          v-model:menu-label="menuLabel"
          v-model:description="description"
          v-model:icon="icon"
          v-model:color="color"
          :kind="object?.kind === 'DASHBOARD' ? 'Dashboard' : 'DataView'"
          hide-scope
          help-popover
        />
        <div>
          <UButton
            :label="t('settings.appMenuEditor.openSettings')"
            icon="i-lucide-settings"
            color="neutral"
            variant="link"
            class="px-0"
            @click="emit('openSettings')"
          />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UTooltip :text="t('settings.appMenuEditor.removeFromMenuHelp')">
          <UButton
            :label="t('settings.appMenuEditor.removeFromMenu')"
            icon="i-lucide-eye-off"
            color="error"
            variant="soft"
            @click="emit('remove'); open = false"
          />
        </UTooltip>
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="outline"
            @click="open = false"
          />
          <UButton
            :label="t('common.save')"
            :loading="saving"
            @click="save"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
