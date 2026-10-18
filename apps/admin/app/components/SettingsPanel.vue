<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
/**
 * The Settings rail group's panel (layouts/default.vue's aside): the
 * sections menu, with a search box above it. Typing searches every
 * setting's label, description and key across all pages (GET
 * /settings/schema, fetched on the first keystroke - never on page load)
 * plus the menu's own page names; picking a setting opens its page
 * scrolled to it (SettingsGroupForm.vue reads the hash).
 */
import type { NavigationMenuItem } from '@nuxt/ui'

const props = defineProps<{
  sections: NavigationMenuItem[][]
}>()

interface SchemaField {
  key: string
  group: string
  label: string
  description: string
  section?: string
}
interface SettingsIndex {
  groups: Record<string, { label: string }>
  fields: SchemaField[]
}

const api = useAdminApi()
const { t } = useI18n()
const catalog = useCatalogText()
const query = ref('')
const term = computed(() => query.value.trim().toLowerCase())

// The index is read once, on the first search - a search cleared and typed
// again before it answers must not start a second read.
const index = ref<SettingsIndex | null>(null)
const loading = ref(false)
let indexLoad: Promise<void> | null = null
watch(term, (value) => {
  if (!value || index.value || indexLoad) return
  loading.value = true
  indexLoad = api.get<SettingsIndex>('/settings/schema')
    .then(({ data }) => { index.value = data })
    .finally(() => {
      indexLoad = null
      loading.value = false
    })
})

const pageItems = computed(() => props.sections.flat().filter(item => item.type !== 'label' && typeof item.to === 'string'))

// A maintenance batch running: flag the Maintenance item, so it stays in
// sight from any Settings page (the batch's own modal lives on that page).
const { batch, watch: watchBatch, stop: unwatchBatch } = useMaintenanceBatch()
onMounted(watchBatch)
onBeforeUnmount(unwatchBatch)
const menuSections = computed(() => {
  if (!batch.value?.active) return props.sections
  return props.sections.map(section => section.map(item =>
    item.to === '/settings/maintenance'
      ? { ...item, badge: { label: t('settings.panel.running'), color: 'primary' as const, variant: 'subtle' as const, size: 'sm' as const } }
      : item
  ))
})
const pageLabel = (to: string) => pageItems.value.find(item => item.to === to)?.label ?? ''

interface Result {
  id: string
  title: string
  subtitle: string
  icon?: string
  to: { path: string, hash?: string }
}

const results = computed<Result[]>(() => {
  const q = term.value
  if (!q) return []
  const pages: Result[] = pageItems.value
    .filter(item => String(item.label).toLowerCase().includes(q))
    .map(item => ({ id: `page:${item.to}`, title: String(item.label), subtitle: t('settings.panel.page'), icon: item.icon, to: { path: String(item.to) } }))
  const settings: Result[] = (index.value?.fields ?? [])
    // Searched in the UI's language and in English (the server's copy).
    .map(f => ({ ...f, title: settingText(f.key, 'label', f.label), text: settingText(f.key, 'description', f.description) }))
    .filter(f => SETTINGS_GROUP_ROUTES[f.group] && [f.title, f.text, f.label, f.description, f.key].some(s => s.toLowerCase().includes(q)))
    // A label match ranks above one found only in the description or key.
    .sort((a, b) => Number(!a.title.toLowerCase().includes(q)) - Number(!b.title.toLowerCase().includes(q)))
    .map((f) => {
      const path = SETTINGS_GROUP_ROUTES[f.group]!
      return {
        id: f.key,
        title: f.title,
        subtitle: [pageLabel(path), f.section && catalog(`settings.metadata.sections.${settingSectionKey(f.section)}`, f.section)].filter(Boolean).join(' › '),
        to: { path, hash: `#${settingAnchor(f.key)}` }
      }
    })
  return [...pages, ...settings]
})

/** A section's key in the settings metadata catalog - "Accounts & sessions" -> accountsSessions (as SettingsGroupForm.vue). */
function settingSectionKey(section: string) {
  return section.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('')
}
function settingText(key: string, part: 'label' | 'description', english: string) {
  return catalog(`settings.metadata.keys.${key.replaceAll('.', '__')}.${part}`, english)
}

function open(result: Result) {
  navigateTo(result.to)
}
function onEnter() {
  if (results.value[0]) open(results.value[0])
}
// The groups' chevrons are decoration (T59) - hidden from assistive technology.
const menuRef = ref<HTMLElement | ComponentPublicInstance | null>(null)
useMenuChevronA11y(menuRef)
</script>

<template>
  <div class="flex flex-col gap-3">
    <UInput
      v-model="query"
      icon="i-lucide-search"
      :placeholder="t('settings.panel.searchSettings')"
      size="sm"
      :loading="loading"
      :aria-label="t('settings.panel.searchSettings')"
      class="w-full"
      @keydown.enter.prevent="onEnter"
      @keydown.esc="query = ''"
    >
      <template
        v-if="query"
        #trailing
      >
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="link"
          size="xs"
          :aria-label="t('settings.panel.clearSearch')"
          @click="query = ''"
        />
      </template>
    </UInput>

    <UNavigationMenu
      v-if="!term"
      ref="menuRef"
      :unmount-on-hide="false"
      orientation="vertical"
      :items="menuSections"
      :aria-label="t('shell.nav.groups.settings')"
      class="w-full"
    />

    <div
      v-else-if="term"
      class="flex flex-col gap-0.5"
    >
      <button
        v-for="result in results"
        :key="result.id"
        type="button"
        class="flex w-full min-w-0 items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-elevated"
        @click="open(result)"
      >
        <UIcon
          :name="result.icon ?? 'i-lucide-sliders-horizontal'"
          class="mt-0.5 size-4 shrink-0 text-muted"
        />
        <span class="flex min-w-0 flex-col">
          <span class="truncate text-sm font-semibold text-highlighted">{{ result.title }}</span>
          <span class="truncate text-xs text-muted">{{ result.subtitle }}</span>
        </span>
      </button>
      <p
        v-if="!results.length && !loading"
        class="px-2.5 py-4 text-center text-sm text-muted"
      >
        {{ t('settings.panel.noMatch', { query: query.trim() }) }}
      </p>
    </div>
  </div>
</template>
