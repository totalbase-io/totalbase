<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
/**
 * A rail group's panel - the second column on desktop, the right half of
 * the mobile navigation slideover (layouts/default.vue renders it in
 * both, so a phone reaches the same trees a desktop does). Database,
 * DataViews, Dashboards, App, Workflows, Templates, Users, Logs, Roles
 * and Settings have their own component; any other group falls back to
 * its `sections` menu.
 */
defineProps<{
  group: AdminNavGroup
  isAdmin: boolean
}>()
// The groups' chevrons are decoration (T59) - hidden from assistive technology.
const menuRef = ref<HTMLElement | ComponentPublicInstance | null>(null)
useMenuChevronA11y(menuRef)
</script>

<template>
  <DatabaseTree v-if="group.key === 'database'" />
  <DataViewsTree v-else-if="group.key === 'dataviews'" />
  <DashboardsTree v-else-if="group.key === 'dashboards'" />
  <AppMenuPanel v-else-if="group.key === 'app'" />
  <WorkflowsTree v-else-if="group.key === 'workflows'" />
  <TemplatesTree v-else-if="group.key === 'templates'" />
  <UsersPanel v-else-if="group.key === 'users' && isAdmin" />
  <UsersDelegatedPanel v-else-if="group.key === 'users'" />
  <LogsPanel v-else-if="group.key === 'logs'" />
  <RolesTree v-else-if="group.key === 'roles'" />
  <SettingsPanel
    v-else-if="group.key === 'settings' && group.sections"
    :sections="group.sections"
  />
  <UNavigationMenu
    v-else-if="group.sections"
    ref="menuRef"
    :key="group.key"
    :unmount-on-hide="false"
    orientation="vertical"
    :items="group.sections"
    :aria-label="group.label"
    class="w-full"
  />
</template>
