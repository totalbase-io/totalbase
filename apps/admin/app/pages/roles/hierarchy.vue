<script setup lang="ts">
/**
 * The roles' hierarchy (Security.md §9.5), every role as an org chart (OrgChart.vue): the top-level roles
 * side by side - a role with no parent and no children is a box of its own up there -, each with its members'
 * count. Built visually: a box dragged onto another goes under it, onto the strip above the chart to the top
 * level, after a confirmation saying what the ceiling change does; PostgreSQL decides (no cycle, four levels).
 * Administrators and Workflows are left out: they're never in a tree. A box opens its role; its "+" creates
 * one under it.
 * Administrators only (the page beside New role); built in the browser from the roles list and the users'
 * counts.
 */
import type { TreeNode } from '~/components/TreeView.vue'
import type { OrgChartItem } from '~/components/OrgChartNode.vue'
import { isValidColorValue, roleColorShade, roleIcon, type Role } from '~/types/permission'

const { t } = useI18n()
const session = useSession()
const colorMode = useColorMode()
const rolesApi = useRolesApi()
const notifyError = useErrorToast()
const toast = useToast()
const { data: roles, refresh: refreshRoles } = useRoles()
const { data: summary } = useUsersSummary()

if (session.access.value !== 'ADMIN') await navigateTo('/roles')

interface RoleItem extends OrgChartItem {
  role: Role
}

// The reserved and administrative roles are never in a tree (Security.md §9.5) - not drawn.
const treeRoles = computed(() => (roles.value ?? []).filter(role => !role.reserved && !role.adminAccess))
const byId = computed(() => new Map(treeRoles.value.map(role => [role.id, role])))
const byName = (a: Role, b: Role) => a.name.localeCompare(b.name)
const childrenOf = computed(() => {
  const children = new Map<string | null, Role[]>()
  for (const role of treeRoles.value) {
    const parent = role.parent && byId.value.has(role.parent) ? role.parent : null
    children.set(parent, [...(children.get(parent) ?? []), role])
  }
  return children
})
const nodes = computed<TreeNode<RoleItem>[]>(() => {
  const node = (role: Role): TreeNode<RoleItem> => {
    const kids = [...(childrenOf.value.get(role.id) ?? [])].sort(byName)
    const count = summary.value?.byRole[role.id] ?? 0
    return {
      id: role.id,
      data: {
        role,
        title: role.name,
        description: t('users.roleHierarchy.members', { n: count }, count),
        icon: roleIcon(role),
        color: role.color,
        image: null,
        muted: !role.active
      },
      children: kids.length > 0 ? kids.map(node) : undefined
    }
  }
  return [...(childrenOf.value.get(null) ?? [])].sort(byName).map(node)
})

const collapsed = ref<string[]>([])
const swatch = (color: string | null) => (color && isValidColorValue(color) ? roleColorShade(color, colorMode.value === 'dark' ? 'dark' : 'light') : undefined)

/** The role and every role below it. */
function branch(id: string): Set<string> {
  const ids = new Set([id])
  const walk = (parent: string) => (childrenOf.value.get(parent) ?? []).forEach((child) => {
    ids.add(child.id)
    walk(child.id)
  })
  walk(id)
  return ids
}
const canDrag = () => true
// Never under itself or its own branch, nor where it already is; the depth is PostgreSQL's.
const canDrop = (draggedId: string, target: TreeNode<RoleItem>) =>
  !branch(draggedId).has(target.id) && byId.value.get(draggedId)?.parent !== target.id

// --- A move, confirmed: it changes the ceiling of the role and of everything below it. ---
const pendingMove = ref<{ role: Role, parent: Role | null } | null>(null)
const moveOpen = computed({
  get: () => pendingMove.value !== null,
  set: (open: boolean) => { if (!open) pendingMove.value = null }
})
const moving = ref(false)
function onMove(id: string, parent: TreeNode<RoleItem> | null) {
  const role = byId.value.get(id)
  if (!role || (parent === null && !role.parent)) return
  pendingMove.value = { role, parent: parent?.data.role ?? null }
}
const moveDescription = computed(() => {
  const move = pendingMove.value
  if (!move) return ''
  const below = branch(move.role.id).size - 1
  return move.parent
    ? t('users.roleHierarchy.moveUnder', { role: move.role.name, parent: move.parent.name, n: below }, below)
    : t('users.roleHierarchy.moveTop', { role: move.role.name, n: below }, below)
})
async function confirmMove() {
  const move = pendingMove.value
  if (!move) return
  moving.value = true
  try {
    await rolesApi.update(move.role.id, { parent: move.parent?.id ?? null })
    toast.add({ title: t('users.roleHierarchy.moved', { role: move.role.name }), color: 'success' })
    pendingMove.value = null
    await Promise.all([refreshRoles(), refreshNuxtData('role-options')])
  } catch (err) {
    // PostgreSQL's refusal (a cycle, a fifth level) - the box stays where it was.
    notifyError(err, t('users.roleHierarchy.moveError'))
  } finally {
    moving.value = false
  }
}

// --- "+": a new role under this box's. ---
const createUnder = ref<string | undefined>(undefined)
const createOpen = computed({
  get: () => createUnder.value !== undefined,
  set: (open: boolean) => { if (!open) createUnder.value = undefined }
})
async function onCreated(role: Role) {
  await refreshNuxtData(['roles-all', 'role-options'])
  await navigateTo(`/roles/${role.id}`)
}
</script>

<template>
  <PageShell :scroll="false">
    <template #header>
      <PageHeader
        :title="t('users.roleHierarchy.title')"
        :description="t('users.roleHierarchy.description')"
        icon="i-lucide-network"
      />
    </template>

    <UEmpty
      v-if="nodes.length === 0"
      icon="i-lucide-network"
      :title="t('users.roleHierarchy.empty')"
      variant="naked"
    />
    <OrgChart
      v-else
      v-model:collapsed="collapsed"
      :nodes="nodes"
      :label="t('users.roleHierarchy.title')"
      :add-label="(node: TreeNode<RoleItem>) => t('users.roleHierarchy.addUnder', { name: node.data.title })"
      :swatch="swatch"
      :can-drag="canDrag"
      :can-drop="canDrop"
      :root-drop-label="t('users.roleHierarchy.topLevel')"
      @open="(node: TreeNode<RoleItem>) => navigateTo(`/roles/${node.id}`)"
      @add-child="(node: TreeNode<RoleItem>) => { createUnder = node.id }"
      @move="onMove"
    />

    <RoleFormModal
      v-model:open="createOpen"
      mode="create"
      :initial-parent="createUnder"
      @saved="onCreated"
    />
    <UModal
      v-model:open="moveOpen"
      :title="t('users.roleHierarchy.moveTitle')"
      :description="moveDescription"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="moving"
            @click="pendingMove = null"
          />
          <UButton
            :label="t('users.roleHierarchy.move')"
            :loading="moving"
            @click="confirmMove"
          />
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
