<script setup lang="ts">
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import { PAGE_NAVBARS_KEY, PANEL_FOLDED_KEY } from '~/utils/page-navbar'

const session = useSession()
const { instance } = useInstance()
const api = useAdminApi()
const route = useRoute()
const colorMode = useColorMode()
const { t } = useI18n()

// One portal shell for everyone (Specification_Security.md §9): an
// administrator sees every group; a user with app access the App plus the
// delegated modules their permissions open (session.modules, from the
// server) - of Users, only the Users page, never other people's tokens or
// sessions.
const isAdmin = computed(() => session.access.value === 'ADMIN')
const navGroups = computed<AdminNavGroup[]>(() => {
  if (isAdmin.value) return translateNavGroups(adminNavGroups, t)
  const modules = new Set<string>(session.modules.value)
  return translateNavGroups(adminNavGroups
    .filter(g => g.key === 'app' || modules.has(g.key))
    .map(g => g.key === 'users' && g.sections ? { ...g, sections: [g.sections.flat().filter(item => item.to === '/users')] } : g), t)
})

// Rail-and-panel nav (Directus-style): the rail is a fixed strip of group
// icons (the ordered navigation groups), and a second fixed-width
// column lists whichever group is active. Which group that is starts as
// whatever the current route belongs to, and re-syncs on every navigation
// (so following a link, the command palette, or a reload always opens the
// right panel).
function groupForPath(path: string): string | undefined {
  if (path.startsWith('/sql-console')) return 'console'
  return navGroups.value.find(g => g.routePrefixes?.some(p => path.startsWith(p)))?.key
}
const activeGroupKey = ref(groupForPath(route.path) ?? (isAdmin.value ? 'status' : 'app'))
watch(() => route.path, (path) => {
  const match = groupForPath(path)
  if (match) activeGroupKey.value = match
})
const activeGroup = computed(() => navGroups.value.find(g => g.key === activeGroupKey.value))
// The DataView designer (pages/dataviews/[id]/design.vue) needs the full
// width for its three panes - the drawer it replaced covered the whole
// screen too - so the group's second column is hidden there.
const isFullWidthEditor = computed(() => /^\/dataviews\/[^/]+\/design$/.test(route.path))
/** The group has a panel (NavGroupPanel.vue) - Dashboard and Console don't. */
function groupHasPanel(key: string) {
  if (['database', 'dataviews', 'dashboards', 'app'].includes(key)) return true
  return key !== 'console' && !!navGroups.value.find(g => g.key === key)?.sections
}
// The compact shell - header + slideover navigation instead of the rail
// and aside - on a phone or a tablet (useCompactUi), so a touch screen
// gives its whole width to the page. Decided in script, not by a CSS
// breakpoint: a CSS-hidden aside still mounts its tree (and fetches its
// data), and on a compact screen the same panel lives in the slideover.
const isCompact = useCompactUi()
const showAside = computed(() => !isCompact.value && !isFullWidthEditor.value && groupHasPanel(activeGroupKey.value))

// The group panel (UDashboardSidebar, Nuxt UI's dashboard template): resizable, its width remembered per
// browser - one for Database, whose tree nests four levels deep, one for every other group, so resizing one
// doesn't change the other -, and collapsible: its header's button folds it away, a rail click opens it again.
const PANEL_SIZES = { database: 340, other: 224 } as const
const panelSizeKey = computed(() => (activeGroupKey.value === 'database' ? 'database' : 'other'))
const nuxtApp = useNuxtApp()
// Pages frame themselves in PageShell, whose navbar carries the phone's ☰; the layout's own header is only for
// a page without one (an empty "Select a ..." placeholder).
const pageNavbars = ref(0)
provide(PAGE_NAVBARS_KEY, pageNavbars)
// Folded, the panel leaves the page entirely - no strip of border, padding and scrollbar, no header button
// spilling over the page's - and the page's header carries the button that opens it again.
const panelCollapsed = ref(false)
provide(PANEL_FOLDED_KEY, computed(() => showAside.value && panelCollapsed.value))
function expandPanel() {
  void nuxtApp.hooks.callHook('dashboard:sidebar:collapse', false)
}

// A Map<key, route> rebuilt whenever navGroups changes (App comes and
// goes) rather than looking the group back up (or passing it whole)
// from the template's @click - passing an AdminNavGroup itself through
// a template expression tripped TS2589 (excessively deep type
// instantiation), most likely from NavigationMenuItem's own recursive/
// generic shape inside `sections`.
const groupDefaultRoute = computed(() => new Map(navGroups.value.map(g => [g.key, firstRouteInGroup(g)])))

// A rail click always jumps to the group's default page (Tables for
// Database, etc.) as well as switching the panel - clicking an icon
// should land you *in* that group, not just open its list and leave you
// wherever you already were.
function selectGroup(key: string) {
  activeGroupKey.value = key
  expandPanel()
  const to = groupDefaultRoute.value.get(key)
  if (to) navigateTo(to)
}

// Mobile: the same rail and panel as desktop, inside a slideover - so a
// phone reaches every tree (a table, a DataView, a role), not just each
// group's top-level pages. A group with a panel behaves like the desktop
// rail (opens the group's default page and shows its panel), but keeps
// the slideover open so the user can pick from that panel; picking
// anything else navigates and closes it.
const isMobileNavOpen = ref(false)
let mobileRailRoute: string | undefined
function selectMobileGroup(key: string) {
  if (!groupHasPanel(key)) {
    isMobileNavOpen.value = false
    selectGroup(key)
    return
  }
  mobileRailRoute = groupDefaultRoute.value.get(key)
  selectGroup(key)
}
// fullPath, not path: a Settings search result can land on the page
// already open, changing only the hash.
watch(() => route.fullPath, () => {
  const fromRail = route.path === mobileRailRoute
  mobileRailRoute = undefined
  if (!fromRail) isMobileNavOpen.value = false
})
// Database's category headings pick what /resources lists through shared
// state, not the URL - already on /resources the route doesn't change.
watch(useDatabaseSelection(), () => {
  isMobileNavOpen.value = false
}, { deep: true })

async function logout() {
  try {
    await api.post('/auth/logout')
  } catch {
    // Best-effort: even if the server call fails, clear local state and leave.
  } finally {
    session.clear()
    navigateTo('/login')
  }
}

// GET /auth/me rides `environment` (NODE_ENV) alongside the admin profile -
// see routes/admin-auth.ts. Badge color is a visual guardrail: production
// should read as "careful" at a glance, not blend in with dev/staging.
const environment = computed(() => session.admin.value?.environment as string | undefined)
const environmentBadgeColor = computed(() => {
  switch (environment.value) {
    case 'production': return 'error'
    case 'staging': return 'warning'
    default: return 'neutral'
  }
})

// Theme + session in one menu (avatar click) rather than separate controls -
// everything about "me" lives in one place instead of spread across the
// navbar. Checkbox items double as a 3-way radio: only one of the three is
// ever checked, driven by colorMode.preference itself.
function setTheme(preference: 'light' | 'dark' | 'system') {
  colorMode.preference = preference
}

const userMenuItems = computed(() => [
  [{ label: session.admin.value?.email, type: 'label' as const }],
  [{ label: t('shell.userMenu.myAccount'), icon: 'i-lucide-circle-user', to: '/account' }],
  [
    { label: t('shell.userMenu.light'), icon: 'i-lucide-sun', type: 'checkbox' as const, checked: colorMode.preference === 'light', onSelect: () => setTheme('light') },
    { label: t('shell.userMenu.dark'), icon: 'i-lucide-moon', type: 'checkbox' as const, checked: colorMode.preference === 'dark', onSelect: () => setTheme('dark') },
    { label: t('shell.userMenu.system'), icon: 'i-lucide-monitor', type: 'checkbox' as const, checked: colorMode.preference === 'system', onSelect: () => setTheme('system') }
  ],
  [{ label: t('shell.userMenu.logOut'), icon: 'i-lucide-log-out', color: 'error' as const, onSelect: logout }]
])

// Command palette (Cmd/Ctrl+K): every leaf link across every group,
// flattened into one searchable group and prefixed with its group's
// label (e.g. "Settings · Assets" vs. "Database · Assets") since two
// different groups can otherwise land on the same bare label.
const commandPaletteGroups = computed<CommandPaletteGroup[]>(() => {
  const items: CommandPaletteItem[] = navGroups.value.flatMap((group) => {
    if (group.to) return [{ label: group.label, icon: group.icon, to: group.to }]
    return (group.sections ?? []).flat()
      .filter(item => item.type !== 'label' && item.to && item.label)
      .map(item => ({ label: `${group.label} · ${item.label}`, icon: item.icon ?? group.icon, to: item.to }))
  })
  return [{ id: 'pages', label: t('shell.commandPalette.pages'), items }]
})
const isCommandPaletteOpen = ref(false)

function onCommandPaletteSelect(item: CommandPaletteItem) {
  isCommandPaletteOpen.value = false
  if (item.to) navigateTo(item.to as string)
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    isCommandPaletteOpen.value = true
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <UDashboardGroup
    unit="px"
    storage="local"
    storage-key="totalbase-shell"
    class="bg-default"
  >
    <!-- The first stop of the keyboard: past the rail and the menu, straight to the page (T58). -->
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-default focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-highlighted focus:ring-2 focus:ring-primary"
    >{{ t('shell.skipToContent') }}</a>
    <!-- Pinned to the visible viewport (fixed inset-0), not a height: the
    page never scrolls as a whole - only <main> does (overflow-y-auto), with
    the rail and panel staying put. Not min-h-screen (the row would grow past
    the viewport with tall content), and not h-screen either: 100vh isn't the
    visible height everywhere - a phone's collapsing URL bar, an embedded
    browser such as VS Code's - and the difference showed as a page-wide
    scrollbar with an empty strip under the app. -->
    <!-- Rail: the groups follow the product navigation order. Only the
    account cluster is anchored at the bottom of the rail. -->
    <!-- data-shell: the anchors the operator's CSS may target (Specification_Admin_UI.md §4.1.1) - rail, panel, header, main. -->
    <nav
      v-if="!isCompact"
      data-shell="rail"
      :aria-label="t('shell.railLabel')"
      class="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-default bg-elevated/50"
    >
      <ActionHeader
        :to="portalHomeFor(session.access.value)"
        :label="isAdmin ? t('shell.nav.groups.status') : t('shell.nav.groups.app')"
        class="mb-2"
      >
        <BrandMark
          icon-only
          size="lg"
          halo
        />
      </ActionHeader>
      <NavRailGroups
        :groups="navGroups"
        :active-key="activeGroupKey"
        :is-admin="isAdmin"
        @select="selectGroup"
      />

      <RailAccountCluster
        :environment="environment"
        :environment-color="environmentBadgeColor"
        :items="userMenuItems"
      />
    </nav>

    <!-- Second column: the active group's panel (UDashboardSidebar). Dashboard has none. Database's is
    DatabaseTree.vue rather than the generic sections menu (navigation.ts). -->
    <!-- On a phone or a tablet its column is hidden and its menu - the rail beside the panel, in a slideover -
    is the navigation, opened by the ☰ of the page's navbar. -->
    <UDashboardSidebar
      v-if="showAside || isCompact"
      :id="isCompact ? 'compact' : panelSizeKey"
      :key="isCompact ? 'compact' : panelSizeKey"
      v-model:open="isMobileNavOpen"
      v-model:collapsed="panelCollapsed"
      data-shell="panel"
      :class="isCompact || panelCollapsed ? 'hidden lg:hidden' : undefined"
      :auto-close="false"
      :resizable="!panelCollapsed"
      collapsible
      :min-size="180"
      :max-size="560"
      :default-size="PANEL_SIZES[panelSizeKey]"
      :toggle="false"
    >
      <template #header>
        <SidebarHeader
          :title="activeGroup?.label ?? ''"
          :icon="activeGroup?.icon"
        >
          <UDashboardSidebarCollapse
            class="ms-auto"
            color="neutral"
            variant="ghost"
          />
        </SidebarHeader>
      </template>
      <NavGroupPanel
        v-if="activeGroup"
        :group="activeGroup"
        :is-admin="isAdmin"
      />
      <template #content>
        <div class="flex h-full min-h-0">
          <nav
            data-shell="rail"
            :aria-label="t('shell.railLabel')"
            class="flex w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-default bg-elevated/50 py-3"
          >
            <NavRailGroups
              :groups="navGroups"
              :active-key="activeGroupKey"
              :is-admin="isAdmin"
              @select="selectMobileGroup"
            />
            <RailAccountCluster
              :environment="environment"
              :environment-color="environmentBadgeColor"
              :items="userMenuItems"
            />
          </nav>
          <div class="flex min-w-0 flex-1 flex-col">
            <SidebarHeader
              :title="activeGroup?.label ?? instance.name"
              :icon="activeGroup?.icon"
            >
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                class="ms-auto"
                :aria-label="t('shell.mobileNav.close')"
                @click="isMobileNavOpen = false"
              />
            </SidebarHeader>
            <div class="flex-1 overflow-y-auto p-2">
              <NavGroupPanel
                v-if="activeGroup && groupHasPanel(activeGroup.key)"
                :group="activeGroup"
                :is-admin="isAdmin"
              />
              <UEmpty
                v-else
                icon="i-lucide-panel-left"
                :title="t('shell.mobileNav.pickSection')"
                :description="t('shell.mobileNav.pickSectionDescription')"
                variant="naked"
                size="sm"
              />
            </div>
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <!-- min-h-0 alongside flex-1: without it, this column has no capped
    height of its own (default overflow:visible flex items get an
    "automatic minimum size" of their CONTENT, not 0) - a standalone
    DataView page's own h-full/min-h-0 chain (DataViewGrid.vue's own doc
    comment) then can't actually bound `main` below to the viewport
    either, so a tall enough table pushes this column past h-screen and
    the document itself grows a second, outer scrollbar alongside
    `main`'s own overflow-y-auto one - a "double scrollbar" with 100
    rows. -->
    <div class="flex-1 flex flex-col min-w-0 min-h-0">
      <!-- Desktop has no top header at all anymore - the rail's own bottom
      cluster (env badge, Database, Settings, avatar menu) replaces it, and the search
      control is gone from the UI entirely (Cmd/Ctrl+K still opens the
      command palette, see onGlobalKeydown). This header only exists for
      mobile, where the rail is hidden and something has to open the
      slideover nav and expose the account menu. -->
      <header
        v-if="isCompact && pageNavbars === 0"
        data-shell="header"
        class="h-14 flex items-center justify-between gap-3 px-4 border-b border-default"
      >
        <UButton
          icon="i-lucide-menu"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('shell.mobileNav.open')"
          @click="isMobileNavOpen = true"
        />
        <div class="flex items-center gap-2">
          <UBadge
            v-if="environment"
            :label="environment"
            :color="environmentBadgeColor"
            variant="subtle"
            size="sm"
            class="uppercase tracking-wide"
          />
          <UDropdownMenu
            :items="userMenuItems"
            :content="{ align: 'end' }"
          >
            <UButton
              icon="i-lucide-user"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="t('shell.account')"
            />
          </UDropdownMenu>
        </div>
      </header>
      <!-- Backgrounds from the theme's tokens, light and dark alike (Nuxt UI's dashboard template): the rail
      the most marked (bg-elevated/50), the panel soft (bg-elevated/25), header and content the page's own
      (bg-default). -->
      <!-- No padding here: every page lays itself out in PageShell
      (header / toolbar / scrolling body / footer - AGENTS.md section 25),
      which owns its own edges. overflow-y-auto stays as the fallback for
      the few frameless pages (empty states). -->
      <ViewAsBanner />
      <main
        id="main"
        tabindex="-1"
        data-shell="main"
        class="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden"
      >
        <slot />
      </main>
    </div>

    <UModal
      v-model:open="isCommandPaletteOpen"
      :ui="{ content: 'max-w-xl' }"
    >
      <template #content>
        <UCommandPalette
          :placeholder="t('shell.commandPalette.placeholder')"
          :groups="commandPaletteGroups"
          @update:model-value="onCommandPaletteSelect"
        />
      </template>
    </UModal>
  </UDashboardGroup>
</template>
