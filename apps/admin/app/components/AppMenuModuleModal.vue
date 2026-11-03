<script setup lang="ts">
/**
 * Arrange menu's Edit on a module entry (Security.md §8.2): its label in the
 * menu (empty: the module's own name) and its icon (empty: the module's), and
 * Remove from the menu - it leaves the arrangement, Add module puts it back;
 * who may open it stays their permissions. The editor owns the tree and its
 * autosave: Save hands the changes back.
 */
import type { MenuModule } from '~/types/app-menu'
import { moduleNav } from '~/utils/app-menu-modules'

const props = defineProps<{ module: MenuModule | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  save: [change: { name: string | null, icon: string | null }]
  remove: []
}>()
const { t } = useI18n()

const draft = reactive({ name: '', icon: undefined as string | undefined })
const moduleName = computed(() => (props.module ? t(moduleNav(props.module.module).labelKey) : ''))
watch(open, (isOpen) => {
  if (!isOpen || !props.module) return
  draft.name = props.module.name ?? ''
  draft.icon = props.module.icon ?? undefined
}, { immediate: true })

function save() {
  emit('save', { name: draft.name.trim().slice(0, 32) || null, icon: draft.icon ?? null })
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.appMenuEditor.editItemTitle', { name: moduleName })"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('settings.appMenuEditor.moduleLabel')"
          :description="t('settings.appMenuEditor.moduleLabelHelp', { name: moduleName })"
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
          v-model="draft.icon"
          :label="t('settings.appMenuEditor.moduleIcon')"
          :help="t('settings.appMenuEditor.moduleIconHelp')"
          clearable
          options="lucide"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UTooltip :text="t('settings.appMenuEditor.removeModuleHelp')">
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
            @click="save"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
