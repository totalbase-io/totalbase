<script setup lang="ts">
/**
 * Arrange menu's settings (Security.md §8.2) as a form: how the App shows the
 * menu (display, how its groups start, the search box) and the App's shell
 * with the standalone menu's header (Admin_UI.md §3.1.1). Each field: a short
 * line under its label and, in its "?", the settings catalog's full text
 * (FieldHelp - a toggletip); each choice with an icon - the display a
 * segmented control (UTabs, as the admin's panels pick a view), the shell
 * cards with a line each, the rest a radio list - never a select, so what is
 * picked and what else there is read at a glance; standalone, the modules the menu holds
 * as a list of switches (Security.md §8.2). Shown beside the tree on a desktop and
 * in a slideover on a compact screen (AppMenuSettingsSlideover.vue); the
 * editor owns the values and their saving - every change is handed back
 * through `change` and applied at once.
 */
import type { AppMenuSettings, MenuModuleName } from '~/types/app-menu'
import { MENU_MODULES, moduleNav } from '~/utils/app-menu-modules'

defineProps<{
  settings: AppMenuSettings
  /** The modules the arrangement holds - each switch's state. */
  placedModules: readonly MenuModuleName[]
}>()
const emit = defineEmits<{
  change: [key: keyof AppMenuSettings, value: string]
  /** A module's switch: on places it at the end of the menu, off takes it out. */
  toggleModule: [module: MenuModuleName, on: boolean]
}>()
const { t } = useI18n()
const MODULES = MENU_MODULES.map(module => ({ module, ...moduleNav(module) }))

type SettingKey = 'app__menu_mode' | 'app__menu_groups_open' | 'app__menu_search' | 'app__shell' | 'app__menu_header'
/** A choice: its value, an icon of its own, the catalog's label and, where it has one, its description - what UTabs and URadioGroup both take. */
type Choice = { value: string, icon: string, label: string, description?: string }
const options = (key: SettingKey, icons: Record<string, string>, described = false): Choice[] => Object.entries(icons).map(([value, icon]) => ({
  value,
  icon,
  label: t(`settings.metadata.keys.${key}.options.${value}`),
  ...(described && { description: t(`settings.metadata.keys.${key}.optionDescriptions.${value}`) })
}))
const MODE_ITEMS = computed(() => options('app__menu_mode', { TREE: 'i-lucide-list-tree', SIDEBAR: 'i-lucide-panel-left' }))
const GROUPS_OPEN_ITEMS = computed(() => options('app__menu_groups_open', { CURRENT: 'i-lucide-folder-check', OPEN: 'i-lucide-folder-open', CLOSED: 'i-lucide-folder' }))
const SEARCH_ITEMS = computed(() => options('app__menu_search', { AUTO: 'i-lucide-search-check', ALWAYS: 'i-lucide-search', NEVER: 'i-lucide-search-x' }))
const SHELL_ITEMS = computed(() => options('app__shell', { SHARED: 'i-lucide-panel-left', STANDALONE: 'i-lucide-app-window' }, true))
const HEADER_ITEMS = computed(() => options('app__menu_header', { LOGO_AND_NAME: 'i-lucide-badge-check', LOGO: 'i-lucide-image', NAME: 'i-lucide-type', NONE: 'i-lucide-minus' }))

/** The fields, in order: the setting each edits, the icon choices it offers, and how - segmented (two short ones), cards (each explained) or a list. */
const FIELDS = computed<{ key: keyof AppMenuSettings, metaKey: SettingKey, items: Choice[], as: 'segmented' | 'cards' | 'list', shown: (settings: AppMenuSettings) => boolean }[]>(() => [
  { key: 'mode', metaKey: 'app__menu_mode', items: MODE_ITEMS.value, as: 'segmented', shown: () => true },
  { key: 'groupsOpen', metaKey: 'app__menu_groups_open', items: GROUPS_OPEN_ITEMS.value, as: 'list', shown: settings => settings.mode === 'TREE' },
  { key: 'search', metaKey: 'app__menu_search', items: SEARCH_ITEMS.value, as: 'list', shown: () => true },
  { key: 'shell', metaKey: 'app__shell', items: SHELL_ITEMS.value, as: 'cards', shown: () => true },
  { key: 'menuHeader', metaKey: 'app__menu_header', items: HEADER_ITEMS.value, as: 'list', shown: settings => settings.shell === 'STANDALONE' }
])
</script>

<template>
  <div class="flex flex-col gap-5">
    <template
      v-for="field in FIELDS"
      :key="field.key"
    >
      <!-- The App's shell starts the second part: what the App is, after what the menu is. -->
      <USeparator v-if="field.key === 'shell'" />
      <UFormField
        v-if="field.shown(settings)"
        :label="t(`settings.metadata.keys.${field.metaKey}.label`)"
        :description="t(`settings.appMenuEditor.short.${field.key}`)"
      >
        <template #hint>
          <FieldHelp
            :text="t(`settings.metadata.keys.${field.metaKey}.description`)"
            :label="t(`settings.metadata.keys.${field.metaKey}.label`)"
          />
        </template>
        <!-- A choice of two short names: one segmented row, icon and label each, no content of its own. -->
        <UTabs
          v-if="field.as === 'segmented'"
          :model-value="settings[field.key]"
          :items="field.items"
          :content="false"
          size="sm"
          class="w-full"
          @update:model-value="(value: string | number) => emit('change', field.key, String(value))"
        />
        <URadioGroup
          v-else
          :model-value="settings[field.key]"
          :items="field.items"
          :variant="field.as === 'cards' ? 'card' : 'list'"
          orientation="vertical"
          :aria-label="t(`settings.metadata.keys.${field.metaKey}.label`)"
          class="w-full"
          @update:model-value="value => emit('change', field.key, String(value))"
        >
          <template #label="{ item }">
            <span class="inline-flex items-center gap-2">
              <UIcon
                :name="item.icon!"
                class="size-4 shrink-0 text-muted"
              />
              <span>{{ item.label }}</span>
            </span>
          </template>
        </URadioGroup>
      </UFormField>
    </template>
    <!-- Standalone, the menu is the rail: which of the admin's screens it holds (Security.md §8.2). -->
    <UFormField
      v-if="settings.shell === 'STANDALONE'"
      :label="t('settings.appMenuEditor.modules')"
      :description="t('settings.appMenuEditor.short.modules')"
    >
      <template #hint>
        <FieldHelp
          :text="t('settings.appMenuEditor.modulesHelp')"
          :label="t('settings.appMenuEditor.modules')"
        />
      </template>
      <div class="flex flex-col gap-2">
        <USwitch
          v-for="item in MODULES"
          :key="item.module"
          :model-value="placedModules.includes(item.module)"
          :label="t(item.labelKey)"
          @update:model-value="(on: boolean) => emit('toggleModule', item.module, on)"
        >
          <template #label>
            <span class="inline-flex items-center gap-2">
              <UIcon
                :name="item.icon"
                class="size-4 shrink-0 text-muted"
              />
              <span>{{ t(item.labelKey) }}</span>
            </span>
          </template>
        </USwitch>
      </div>
    </UFormField>
  </div>
</template>
