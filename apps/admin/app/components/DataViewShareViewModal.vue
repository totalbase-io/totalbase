<script setup lang="ts">
/**
 * Share a saved view (its owner - DataViews.md §5.9): one search over roles and people - picking
 * one shares it at once -, the list of who has it, each stopped with its ×, and "Copy link" at the foot - a link
 * applies the view once and is never added to the opener's own list. The roles and people offered are the
 * server's (`share-candidates`): for one who isn't an administrator, their own roles and the people holding one
 * of them. `shared-count` reports each add/remove so the views popover's share icon stays in sync without a refetch.
 */
import type { SavedView, SavedViewRecipient } from '~/types/dataview'

const props = defineProps<{
  dataviewId: string
  dataviewSlug: string
  view: SavedView | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ 'shared-count': [delta: number] }>()

const appApi = useAppApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const recipients = ref<SavedViewRecipient[]>([])
const loading = ref(false)
const sharing = ref(false)

const label = (recipient: SavedViewRecipient) => recipient.name || recipient.email || recipient.id
const sharesPath = computed(() => `/dataviews/${props.dataviewId}/saved-views/${props.view?.id}/shares`)
/** Who has it - roles first, then people, each by name. */
const sortedRecipients = computed(() => [...recipients.value].sort((x, y) => (x.kind === y.kind ? label(x).localeCompare(label(y)) : x.kind === 'ROLE' ? -1 : 1)))

// One search over whom the sharer may share with - the server's answer (`share-candidates`): its roles, filtered
// here by the term, and the people it finds by name or email. Picking one shares it at once.
interface Candidate { id: string, name: string | null, detail: string | null }
/** An option - or, `type: 'label'`, a group's title (Roles, People). */
interface PickItem { value: string, label: string, description?: string, icon?: string, avatar?: { alt: string }, kind: 'ROLE' | 'USER', type?: 'label' }
const roleCandidates = ref<Candidate[]>([])
const userCandidates = ref<Candidate[]>([])
const searchTerm = ref('')
const picked = ref<string | undefined>(undefined)
let searchTimer: ReturnType<typeof setTimeout> | undefined
async function loadCandidates(term: string) {
  try {
    const { data } = await appApi.get<{ roles: Candidate[], users: Candidate[] }>(`/dataviews/${props.dataviewId}/saved-views/share-candidates`, { q: term.trim() || undefined })
    roleCandidates.value = data.roles
    userCandidates.value = data.users
  } catch {
    userCandidates.value = []
  }
}
watch(searchTerm, (term) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadCandidates(term), 250)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

/** Roles, then people - what isn't shared with yet. */
const pickItems = computed(() => {
  const has = new Set(recipients.value.map(r => r.id))
  const term = searchTerm.value.trim().toLowerCase()
  const roleItems: PickItem[] = roleCandidates.value
    .filter(r => !has.has(r.id) && (!term || (r.name ?? '').toLowerCase().includes(term)))
    .map(r => ({ value: r.id, label: r.name ?? r.id, ...(r.detail && { description: r.detail }), icon: 'i-lucide-shield', kind: 'ROLE' }))
  const userItems: PickItem[] = userCandidates.value
    .filter(u => !has.has(u.id))
    .map(u => ({ value: u.id, label: u.name || u.detail || u.id, ...(u.name && u.detail && { description: u.detail }), avatar: { alt: u.name || u.detail || u.id }, kind: 'USER' }))
  const groups: PickItem[][] = []
  if (roleItems.length) groups.push([{ type: 'label', value: '', label: t('dataviews.shareView.roles'), kind: 'ROLE' }, ...roleItems])
  if (userItems.length) groups.push([{ type: 'label', value: '', label: t('dataviews.shareView.people'), kind: 'USER' }, ...userItems])
  return groups
})

watch([open, () => props.view?.id], async ([isOpen]) => {
  if (!isOpen || !props.view) return
  picked.value = undefined
  searchTerm.value = ''
  recipients.value = []
  loading.value = true
  void loadCandidates('')
  try {
    recipients.value = (await appApi.get<SavedViewRecipient[]>(sharesPath.value)).data
  } catch (err) {
    notifyError(err, t('dataviews.shareView.loadError'))
  } finally {
    loading.value = false
  }
}, { immediate: true })

/** A pick shares at once, and the search is ready for the next one. */
watch(picked, (id) => {
  if (!id) return
  const item = pickItems.value.flat().find(i => !i.type && i.value === id)
  picked.value = undefined
  searchTerm.value = ''
  if (item) void add(item.kind === 'ROLE' ? { roleId: id } : { userId: id })
})

async function add(target: { roleId: string } | { userId: string }) {
  if (!props.view) return
  sharing.value = true
  try {
    const { data: recipient } = await appApi.post<SavedViewRecipient>(sharesPath.value, { data: target })
    // Sharing twice is a no-op - the recipient is already listed.
    if (!recipients.value.some(r => r.id === recipient.id)) {
      recipients.value = [...recipients.value, recipient]
      emit('shared-count', 1)
    }
  } catch (err) {
    notifyError(err, t('dataviews.shareView.shareError'))
  } finally {
    sharing.value = false
  }
}

async function remove(id: string) {
  try {
    await appApi.del(`${sharesPath.value}/${id}`)
    recipients.value = recipients.value.filter(r => r.id !== id)
    emit('shared-count', -1)
  } catch (err) {
    notifyError(err, t('dataviews.shareView.removeError'))
  }
}

/** The link itself is the credential (DataViewsStatesService.getForLink) - nothing to create server-side. */
function copyLink() {
  if (!props.view) return
  const url = `${window.location.origin}/app/dataviews/${props.dataviewSlug}?view=${props.view.id}`
  navigator.clipboard?.writeText(url)
    .then(() => toast.add({ title: t('dataviews.shareView.linkCopied'), color: 'success' }))
    .catch(() => toast.add({ title: t('dataviews.shareView.copyError'), color: 'error' }))
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('dataviews.shareView.title', { name: view?.name ?? '' })"
    :description="t('dataviews.shareView.helpDescription')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <USelectMenu
          v-model="picked"
          v-model:search-term="searchTerm"
          :items="pickItems"
          value-key="value"
          ignore-filter
          :loading="sharing"
          icon="i-lucide-user-plus"
          :placeholder="t('dataviews.shareView.addAnyone')"
          :aria-label="t('dataviews.shareView.addAnyone')"
          class="w-full"
        />

        <UEmpty
          v-if="loading"
          loading
          variant="naked"
          size="sm"
        />
        <p
          v-else-if="!sortedRecipients.length"
          class="text-sm text-muted"
        >
          {{ t('dataviews.shareView.nobody') }}
        </p>
        <section
          v-else
          class="flex flex-col gap-1"
        >
          <p class="text-xs font-medium uppercase tracking-wide text-muted">
            {{ t('dataviews.shareView.withAccess') }}
          </p>
          <div
            v-for="recipient in sortedRecipients"
            :key="recipient.id"
            class="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-elevated"
          >
            <template v-if="recipient.kind === 'ROLE'">
              <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated">
                <UIcon
                  name="i-lucide-shield"
                  class="size-4 text-muted"
                />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ label(recipient) }}</span>
                <span class="block truncate text-xs text-muted">{{ t('dataviews.shareView.role') }}</span>
              </span>
            </template>
            <UUser
              v-else
              :name="label(recipient)"
              :description="recipient.name ? (recipient.email ?? undefined) : undefined"
              :avatar="{ alt: label(recipient) }"
              class="min-w-0 flex-1"
            />
            <UTooltip :text="t('dataviews.shareView.stopSharing')">
              <UButton
                icon="i-lucide-x"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="t('dataviews.shareView.stopSharing')"
                @click="remove(recipient.id)"
              />
            </UTooltip>
          </div>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UTooltip :text="t('dataviews.shareView.linkNote')">
          <UButton
            :label="t('dataviews.shareView.copyLink')"
            icon="i-lucide-link"
            color="neutral"
            variant="ghost"
            @click="copyLink"
          />
        </UTooltip>
        <UButton
          :label="t('common.done')"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
      </div>
    </template>
  </UModal>
</template>
