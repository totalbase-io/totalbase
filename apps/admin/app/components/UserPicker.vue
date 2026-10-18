<script setup lang="ts">
/**
 * Pick one user by searching the server (GET /users?q=...&limit=...) -
 * never by loading every account. The selected user's label comes from
 * the shared user directory (useUserDirectory), so a preselected id
 * renders its name without being in the current search results.
 */
import type { AdminUserListItem } from '~/types/security'

const props = withDefaults(defineProps<{
  /** Only active accounts (e.g. "execute as"). */
  activeOnly?: boolean
  /** Ids that can't be picked (e.g. a saved view's current recipients). */
  exclude?: string[]
  disabled?: boolean
}>(), {
  activeOnly: false,
  exclude: () => [],
  disabled: false
})
const model = defineModel<string | null | undefined>()

const api = useAdminApi()
const directory = useUserDirectory()

const searchTerm = ref('')
const results = ref<AdminUserListItem[]>([])
const loading = ref(false)
// Only the latest search's results show - one typed faster than the server answers must not land late.
const latestSearch = useLatest()

async function search(term: string) {
  const load = latestSearch.next()
  loading.value = true
  try {
    const { data } = await api.get<AdminUserListItem[]>('/users', {
      limit: 20,
      ...(term.trim() && { q: term.trim() }),
      ...(props.activeOnly && { active: 'true' })
    })
    if (!load.isCurrent()) return
    results.value = data
    const next = { ...directory.entries.value }
    for (const user of data) next[user.id] = { name: user.name, email: user.email, avatarUrl: user.avatarUrl }
    directory.entries.value = next
  } catch {
    if (load.isCurrent()) results.value = []
  } finally {
    if (load.isCurrent()) loading.value = false
  }
}
const debouncedTerm = useDebouncedRef(() => searchTerm.value)
watch(debouncedTerm, search)

// The first search runs when the menu opens, not on mount - most pickers
// on a page are never opened.
const opened = ref(false)
function onOpen(isOpen: boolean) {
  if (isOpen && !opened.value) {
    opened.value = true
    search('')
  }
}

watch(model, (id) => {
  if (id) directory.ensure([id])
}, { immediate: true })

// The menu itself only speaks string | undefined; a null model (e.g. a
// trigger's unset "execute as") reads as nothing selected.
const selected = computed({
  get: () => model.value ?? undefined,
  set: (value: string | undefined) => {
    if (value) model.value = value
  }
})

interface Item { label: string, description?: string, value: string, avatar: { src?: string, alt: string } }
const items = computed<Item[]>(() => {
  const list: Item[] = results.value
    .filter(u => !props.exclude.includes(u.id))
    .map(u => ({
      label: u.name || u.email || u.id,
      description: u.name ? (u.email ?? undefined) : undefined,
      value: u.id,
      avatar: { src: u.avatarUrl ?? undefined, alt: u.name || u.email || '' }
    }))
  // Keep the current selection in the list so the trigger can show it.
  if (model.value && !list.some(item => item.value === model.value)) {
    const label = directory.label(model.value)
    list.unshift({ label, description: directory.email(model.value) ?? undefined, value: model.value, avatar: { src: directory.avatar(model.value) ?? undefined, alt: label } })
  }
  return list
})
</script>

<template>
  <USelectMenu
    v-model="selected"
    v-model:search-term="searchTerm"
    :items="items"
    value-key="value"
    :loading="loading"
    :disabled="disabled"
    ignore-filter
    :avatar="model ? { src: directory.avatar(model) ?? undefined, alt: directory.label(model) } : undefined"
    :icon="model ? undefined : 'i-lucide-user'"
    class="w-full"
    @update:open="onOpen"
  />
</template>
