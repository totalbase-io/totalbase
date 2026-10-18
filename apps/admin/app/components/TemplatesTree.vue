<script setup lang="ts">
/**
 * The Templates rail group's own nav panel (layouts/default.vue's aside,
 * `activeGroupKey === 'templates'`) - same "New button, search, grouped
 * list, leaf click jumps straight to its own editor page" pattern
 * WorkflowsTree.vue/DataViewsTree.vue use. Grouped by `kind`: EMAILS
 * (`MAILING` rows - today a mailing template only ever feeds an email)
 * and PDF. Unlike DataViewsTree, both groups always render, even empty -
 * there are only two, and an empty group still tells the user where a
 * new template of that kind will land.
 *
 * Creation lives in NewTemplateModal.vue, opened from here; on success
 * the new row shows up in its kind's group and its editor opens.
 * Deliberately no per-row delete (same call WorkflowsTree.vue made) -
 * delete lives only in the editor's own header menu.
 */
import { TEMPLATE_KIND_META, TEMPLATE_KINDS, type TemplateKind, type TemplateSummary } from '~/utils/templates'
import type { SystemEmailSummary } from '~/utils/system-emails'
import { useCatalogText } from '~/utils/catalog-text'

const api = useAdminApi()
const { t } = useI18n()
const catalogText = useCatalogText()
const templatesApi = useTemplatesApi()
const session = useSession()
// System emails are instance settings - administrators only; templates follow the caller's permissions.
const isAdmin = computed(() => session.access.value === 'ADMIN')
const route = useRoute()

const { data: templates, refresh, error } = await useAsyncData(
  'templates-tree',
  () => templatesApi.list(),
  { default: () => [] }
)

const search = ref('')

// System emails (invitation, password reset, ...) - a fixed set of
// settings, not rows: always listed, never created or deleted here.
const { data: systemEmails } = await useAsyncData(
  'system-emails',
  () => isAdmin.value ? api.get<SystemEmailSummary[]>('/system-emails').then(r => r.data) : Promise.resolve([] as SystemEmailSummary[]),
  { default: () => [] }
)
const filteredSystemEmails = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return (systemEmails.value ?? []).filter(e => !query || systemEmailLabel(e).toLocaleLowerCase().includes(query))
})
/** A system email's name in the UI's language - the server's English when there's no translation. */
const systemEmailLabel = (e: SystemEmailSummary) => catalogText(`content.systemEmails.slots.${e.slot}.label`, e.label)
const selectedSlot = computed(() => route.params.slot as string | undefined)

const templatesByKind = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const map = new Map<TemplateKind, TemplateSummary[]>(TEMPLATE_KINDS.map(kind => [kind, []]))
  for (const template of templates.value ?? []) {
    if (query && !template.name.toLocaleLowerCase().includes(query) && !template.slug.toLocaleLowerCase().includes(query)) continue
    map.get(template.kind)?.push(template)
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return map
})

const selectedId = computed(() => route.params.id as string | undefined)

const open = ref(false)

async function onCreated(template: TemplateSummary) {
  await refresh()
  await navigateTo(`/templates/${template.id}`)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UButton
      v-if="session.can('templates', 'CREATE')"
      icon="i-lucide-plus"
      :label="t('content.templates.newTemplate')"
      block
      @click="open = true"
    />
    <UInput
      v-model="search"
      icon="i-lucide-search"
      :aria-label="t('content.templates.tree.searchAria')"
      :placeholder="t('content.templates.tree.searchPlaceholder')"
      class="w-full"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('content.templates.tree.loadError')"
    />
    <div
      v-else
      class="flex flex-col gap-4"
    >
      <section
        v-for="kind in TEMPLATE_KINDS"
        :key="kind"
      >
        <div class="flex w-full items-center pb-2 text-xs font-medium uppercase tracking-wide text-muted">
          <span>{{ t(`content.templates.kinds.${kind}.group`) }}</span>
          <span class="ms-auto text-xs font-normal">{{ templatesByKind.get(kind)?.length ?? 0 }}</span>
        </div>
        <div class="flex flex-col">
          <button
            v-for="template in templatesByKind.get(kind)"
            :key="template.id"
            type="button"
            class="flex min-w-0 items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-elevated hover:text-highlighted"
            :class="template.id === selectedId ? 'bg-elevated text-highlighted' : 'text-default'"
            @click="navigateTo(`/templates/${template.id}`)"
          >
            <UIcon
              :name="TEMPLATE_KIND_META[kind].icon"
              class="size-4 shrink-0 text-muted"
            />
            <span class="truncate">{{ template.name }}</span>
          </button>
          <p
            v-if="(templatesByKind.get(kind)?.length ?? 0) === 0"
            class="px-3 py-1 text-xs text-muted"
          >
            {{ search.trim() ? t('content.templates.tree.noMatches') : t('content.templates.tree.noneYet') }}
          </p>
        </div>
      </section>

      <section v-if="isAdmin">
        <div class="flex w-full items-center pb-2 text-xs font-medium uppercase tracking-wide text-muted">
          <span>{{ t('content.templates.tree.system') }}</span>
          <span class="ms-auto text-xs font-normal">{{ filteredSystemEmails.length }}</span>
        </div>
        <div class="flex flex-col">
          <button
            v-for="systemEmail in filteredSystemEmails"
            :key="systemEmail.slot"
            type="button"
            class="flex min-w-0 items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-elevated hover:text-highlighted"
            :class="systemEmail.slot === selectedSlot ? 'bg-elevated text-highlighted' : 'text-default'"
            @click="navigateTo(`/templates/system/${systemEmail.slot}`)"
          >
            <UIcon
              name="i-lucide-mail-check"
              class="size-4 shrink-0 text-muted"
            />
            <span
              class="truncate"
              :class="systemEmail.enabled === false ? 'text-muted' : undefined"
            >{{ systemEmailLabel(systemEmail) }}</span>
            <UTooltip
              v-if="systemEmail.overridden"
              :text="t('content.templates.tree.edited')"
            >
              <span class="ms-auto size-1.5 shrink-0 rounded-full bg-primary" />
            </UTooltip>
            <span
              v-else-if="systemEmail.enabled === false"
              class="ms-auto text-xs text-muted"
            >{{ t('content.templates.tree.off') }}</span>
          </button>
          <p
            v-if="filteredSystemEmails.length === 0"
            class="px-3 py-1 text-xs text-muted"
          >
            {{ t('content.templates.tree.noMatches') }}
          </p>
        </div>
      </section>
    </div>

    <NewTemplateModal
      v-model:open="open"
      @created="onCreated"
    />
  </div>
</template>
