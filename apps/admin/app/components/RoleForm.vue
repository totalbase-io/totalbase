<script setup lang="ts">
// A role's own fields - name, description, icon, color, access, App home,
// capabilities - and their save, one form for New role (RoleFormModal.vue)
// and the role's Settings tab (RoleAdminEditor.vue, the delegated editor's
// Details modal): same fields, same validation. The container owns the
// buttons and calls `submit()`; `seed` re-reads the role (a modal, each open).
import type { Role, RoleColor } from '~/types/permission'
import type { Capability, RoleWrite } from '~/composables/useRolesApi'
import { ROLE_ACCESS_FLAGS, type RoleAccessFlag, type RoleAccessFlags } from '~/utils/role-access'
import { useApiErrorMessage } from '~/utils/api-error-message'
import type { AppMenu, MenuNode, MenuObject } from '~/types/app-menu'

const props = defineProps<{
  mode: 'create' | 'edit'
  role?: Role | null
}>()
const emit = defineEmits<{ saved: [Role] }>()

const api = useAdminApi()
const rolesApi = useRolesApi()
const toast = useToast()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
// A delegated user writes through the Data API: name, description, icon and
// colour only - access flags and default permissions are the administrator's.
const session = useSession()
const isAdmin = computed(() => session.access.value === 'ADMIN')

const name = ref('')
const description = ref('')
const icon = ref<string | undefined>(undefined)
const color = ref<RoleColor | undefined>(undefined)
// A new role starts with app access only (the column defaults).
const DEFAULT_FLAGS: RoleAccessFlags = { adminAccess: false, appAccess: true, apiAccess: false }
const flags = ref<RoleAccessFlags>({ ...DEFAULT_FLAGS })
const saving = ref(false)
// Its access reviewed periodically (Security.md §1.8): a reminder on its Access reviews, as Administrators has.
const reviewRequired = ref(false)
// Its App home (Security.md §8.1): one of the menu's objects, `KIND:id`; undefined = the App's own page.
const home = ref<string | undefined>(undefined)
const homeOptions = ref<{ value: string, label: string, description: string, icon: string }[]>([])
async function loadHomeOptions() {
  if (!isAdmin.value || homeOptions.value.length) return
  try {
    // Each with where it sits in the menu - two "New" in different groups read apart.
    const objects: { object: MenuObject, path: string[] }[] = []
    const walk = (nodes: MenuNode[], path: string[]) => nodes.forEach(node => node.kind === 'GROUP' ? walk(node.children, [...path, node.name]) : objects.push({ object: node, path }))
    walk((await api.get<AppMenu>('/app/menu')).data.nodes, [])
    homeOptions.value = objects.map(({ object, path }) => ({
      value: `${object.kind}:${object.id}`,
      label: object.menuLabel || object.name,
      description: [...path, object.kind === 'DATAVIEW' ? t('users.roleForm.homeDataview') : t('users.roleForm.homeDashboard')].join(' › '),
      icon: object.icon ?? (object.kind === 'DATAVIEW' ? 'i-lucide-table' : 'i-lucide-layout-dashboard')
    }))
  } catch (err) {
    notifyError(err, t('users.roleForm.homeLoadError'))
  }
}
// The role's capabilities (roles_capabilities, Security.md
// §5.2) - their own grant rows, not role columns, so a reserved role's
// switches work too. `grants` are the rows as loaded; null = none.
const CAPABILITIES: Capability[] = ['TRANSACTIONS', 'SEND_EMAIL', 'MANAGE_ROLES']
const noGrants = (): Record<Capability, 'ALLOW' | 'DENY' | null> => ({ TRANSACTIONS: null, SEND_EMAIL: null, MANAGE_ROLES: null })
const notAllowed = (): Record<Capability, boolean> => ({ TRANSACTIONS: false, SEND_EMAIL: false, MANAGE_ROLES: false })
const grants = ref(noGrants())
const allowed = ref<Record<Capability, boolean>>(notAllowed())

// The role above it (Security.md §9.5): its ceiling, and its managers' scope. An administrator places any role
// that isn't reserved under any other but itself and its descendants; a manager, under a role they manage.
const parent = ref<string | undefined>(undefined)
const { data: allRoles } = useRoles()
const parentOptions = computed(() => {
  const roles = allRoles.value ?? []
  const editing = props.mode === 'edit' ? props.role?.id : undefined
  const below = new Set<string>()
  if (editing) {
    let grew = true
    below.add(editing)
    while (grew) {
      grew = false
      for (const role of roles) {
        if (role.parent && below.has(role.parent) && !below.has(role.id)) {
          below.add(role.id)
          grew = true
        }
      }
    }
  }
  const placeable = isAdmin.value ? null : new Set(session.admin.value?.placeableRoles ?? [])
  return roles
    .filter(role => !role.reserved && !role.adminAccess && !below.has(role.id) && (placeable === null || placeable.has(role.id)))
    .map(role => ({ value: role.id, label: role.name }))
})
const canPlace = computed(() => isAdmin.value || (props.mode === 'create' && (session.admin.value?.placeableRoles?.length ?? 0) > 0))
const capabilitiesLoading = ref(false)

// Only offered on create - an existing role already has its own "Apply
// Default Permissions" button on the totalbase tab (roles/[id].vue), no
// need to duplicate the choice here once the role exists. Defaults to on:
// the common case (any fresh install
// needs its own end-user-facing app to see assets/mailings/etc. from day
// one) should be the one less clicking, not the exception.
const applyTotalbaseDefaults = ref(true)

// Reserved role (the Administrators role): the server
// rejects any update to it outright (RolesService.update()'s
// assertNotReserved, unconditional - not just for name), so every field
// here is disabled rather than only the ones the copy elsewhere
// mentions ("cannot be renamed, deactivated, or deleted").
const reserved = computed(() => props.mode === 'edit' && props.role?.reserved === true)

// Admin access is reserved-only (a CHECK constraint on the table): always
// shown so the three flags read as one model, never editable - it's
// checked only on the seeded roles. App and API are independent.
function flagLocked(flag: RoleAccessFlag): boolean {
  return reserved.value || flag === 'adminAccess'
}
function setFlag(flag: RoleAccessFlag, value: boolean) {
  flags.value = { ...flags.value, [flag]: value }
}

/** The draft from the role (edit) or blank (create) - on mount, and again whenever the container asks (a modal re-opened, the role refreshed). */
function seed() {
  if (props.mode === 'edit' && props.role) {
    name.value = props.role.name
    description.value = props.role.description ?? ''
    icon.value = props.role.icon ?? undefined
    color.value = (props.role.color as RoleColor | null) ?? undefined
    flags.value = { adminAccess: props.role.adminAccess, appAccess: props.role.appAccess, apiAccess: props.role.apiAccess }
    home.value = props.role.homeDataview ? `DATAVIEW:${props.role.homeDataview}` : props.role.homeDashboard ? `DASHBOARD:${props.role.homeDashboard}` : undefined
    parent.value = props.role.parent ?? undefined
    reviewRequired.value = props.role.reviewRequired === true
    void loadCapabilities(props.role.id)
  } else {
    name.value = ''
    description.value = ''
    icon.value = undefined
    color.value = undefined
    flags.value = { ...DEFAULT_FLAGS }
    home.value = undefined
    applyTotalbaseDefaults.value = true
    grants.value = noGrants()
    allowed.value = notAllowed()
    reviewRequired.value = false
    // A manager's new role goes under the role they manage from.
    parent.value = isAdmin.value ? undefined : session.admin.value?.placeableRoles?.[0]
  }
  void loadHomeOptions()
}
seed()
watch(() => props.role, seed)

async function loadCapabilities(roleId: string) {
  grants.value = noGrants()
  allowed.value = notAllowed()
  if (!isAdmin.value) return
  capabilitiesLoading.value = true
  try {
    const loaded = await Promise.all(CAPABILITIES.map(capability => rolesApi.capabilityGrant(roleId, capability)))
    grants.value = { TRANSACTIONS: loaded[0]!, SEND_EMAIL: loaded[1]!, MANAGE_ROLES: loaded[2]! }
    allowed.value = { TRANSACTIONS: loaded[0] === 'ALLOW', SEND_EMAIL: loaded[1] === 'ALLOW', MANAGE_ROLES: loaded[2] === 'ALLOW' }
  } catch (err) {
    notifyError(err, t('users.roleForm.capabilitiesLoadError'))
  } finally {
    capabilitiesLoading.value = false
  }
}

/**
 * One path for everyone - the Data API. Only the columns that changed are
 * sent: each needs its own field grant for a delegated user. An
 * administrator also sets the access flags; nobody else may.
 */
async function save(values: RoleWrite): Promise<Role> {
  const body: RoleWrite = isAdmin.value
    ? values
    : { name: values.name, description: values.description, icon: values.icon, color: values.color, ...(props.mode === 'create' && values.parent && { parent: values.parent }) }
  if (props.mode !== 'edit' || !props.role) return rolesApi.create(body)
  const role = props.role
  const changed = Object.fromEntries(Object.entries(body).filter(([key, value]) => role[key as keyof RoleWrite] !== value)) as RoleWrite
  return Object.keys(changed).length > 0 ? rolesApi.update(role.id, changed) : role
}

async function submit() {
  saving.value = true
  try {
    const body = {
      name: name.value.trim(),
      description: description.value.trim() || null,
      icon: icon.value ?? null,
      color: color.value ?? null,
      // adminAccess is never sent - the server rejects it on any request.
      appAccess: flags.value.appAccess,
      apiAccess: flags.value.apiAccess,
      homeDataview: home.value?.startsWith('DATAVIEW:') ? home.value.slice('DATAVIEW:'.length) : null,
      homeDashboard: home.value?.startsWith('DASHBOARD:') ? home.value.slice('DASHBOARD:'.length) : null,
      parent: parent.value ?? null,
      reviewRequired: reviewRequired.value
    }
    const data = await save(body)
    if (isAdmin.value) {
      for (const capability of CAPABILITIES) {
        if (allowed.value[capability] !== (grants.value[capability] === 'ALLOW')) {
          await rolesApi.setCapabilityAllowed(data.id, capability, allowed.value[capability], grants.value[capability])
        }
      }
    }
    emit('saved', data)

    if (isAdmin.value && props.mode === 'create' && applyTotalbaseDefaults.value) {
      try {
        await applyTotalbaseDefaultPermissions(api, data.id)
      } catch (err) {
        // The role itself was created fine - a failure here is its own,
        // narrower problem (e.g. catalog not yet reconciled for a newly
        // exposed table), not a reason to make the whole create look
        // like it failed. Surfaced as its own toast, role creation's own
        // toast still fires below.
        toast.add({
          title: t('users.roleForm.defaultsError'),
          description: errorMessage(err),
          color: 'warning'
        })
      }
    }
    toast.add({ title: props.mode === 'edit' ? t('users.roleForm.updated') : t('users.roleForm.created'), color: 'success' })
  } catch (err) {
    notifyError(err, props.mode === 'edit' ? t('users.roleEditor.updateError') : t('users.roleForm.createError'))
  } finally {
    saving.value = false
  }
}

defineExpose({ submit, seed, saving, reserved })
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField
      :label="t('common.name')"
      required
    >
      <UInput
        v-model="name"
        class="w-full"
        :disabled="reserved"
        @keyup.enter="submit"
      />
    </UFormField>
    <UFormField
      :label="t('common.description')"
      :description="t('users.roleForm.descriptionHelp')"
    >
      <UInput
        v-model="description"
        class="w-full"
        :disabled="reserved"
      />
    </UFormField>
    <div class="flex gap-3">
      <IconPickerField
        v-model="icon"
        :label="t('common.icon')"
        :disabled="reserved"
      />
      <ColorPickerField
        v-model="color"
        :label="t('common.color')"
        :disabled="reserved"
      />
    </div>
    <p
      v-if="reserved"
      class="text-xs text-muted"
    >
      {{ isAdmin ? t('users.roleForm.reservedAdmin') : t('users.roleForm.reserved') }}
    </p>
    <UFormField
      v-if="canPlace && !reserved"
      :label="t('users.roleForm.parent')"
      :description="t('users.roleForm.parentHelp')"
    >
      <USelectMenu
        v-model="parent"
        :items="parentOptions"
        value-key="value"
        :aria-label="t('users.roleForm.parent')"
        :search-input="{ placeholder: t('common.search') }"
        :clear="isAdmin"
        class="w-full"
      />
    </UFormField>
    <UFormField
      v-if="isAdmin"
      :label="t('users.roleForm.access')"
      :description="t('users.roleForm.accessHelp')"
    >
      <div class="mt-1 flex flex-col gap-3">
        <label
          v-for="flag in ROLE_ACCESS_FLAGS"
          :key="flag"
          class="flex items-start gap-2"
          :class="flagLocked(flag) ? 'cursor-not-allowed' : 'cursor-pointer'"
        >
          <UCheckbox
            :model-value="flags[flag]"
            :disabled="flagLocked(flag)"
            @update:model-value="(v: boolean | 'indeterminate') => setFlag(flag, v === true)"
          />
          <span class="flex flex-col">
            <span class="flex items-center gap-1.5 text-sm">
              <UIcon
                :name="ROLE_ACCESS_META[flag].icon"
                class="size-3.5 text-muted"
              />
              {{ t(ROLE_ACCESS_META[flag].labelKey) }}
            </span>
            <span class="text-xs text-muted">{{ t(ROLE_ACCESS_META[flag].descriptionKey) }}</span>
            <span
              v-if="flag === 'adminAccess' && !reserved"
              class="text-xs text-muted"
            >{{ t('users.roleForm.adminReserved') }}</span>
          </span>
        </label>
        <p
          v-if="!flags.adminAccess && !flags.appAccess && !flags.apiAccess"
          class="text-xs text-warning"
        >
          {{ t('users.roleForm.noAccessWarning') }}
        </p>
      </div>
    </UFormField>
    <UFormField
      v-if="isAdmin && flags.appAccess"
      :label="t('users.roleForm.home')"
      :description="t('users.roleForm.homeHelp')"
    >
      <USelectMenu
        v-model="home"
        :items="homeOptions"
        value-key="value"
        :aria-label="t('users.roleForm.home')"
        :search-input="{ placeholder: t('common.search') }"
        clear
        class="w-full"
        :disabled="reserved"
      />
    </UFormField>
    <!-- Not a UFormField: it would give both switches its one id and label. -->
    <div
      v-if="isAdmin"
      class="flex flex-col gap-3"
    >
      <p class="text-sm font-medium text-default">
        {{ t('users.roleForm.capabilities') }}
      </p>
      <div class="flex flex-col gap-3">
        <USwitch
          v-model="allowed.TRANSACTIONS"
          :label="t('users.roleForm.transactions')"
          :description="t('users.roleForm.transactionsHelp')"
          :disabled="capabilitiesLoading"
        />
        <USwitch
          v-model="allowed.SEND_EMAIL"
          :label="t('users.roleForm.sendEmail')"
          :description="t('users.roleForm.sendEmailHelp')"
          :disabled="capabilitiesLoading"
        />
        <USwitch
          v-model="allowed.MANAGE_ROLES"
          :label="t('users.roleForm.manageRoles')"
          :description="t('users.roleForm.manageRolesHelp')"
          :disabled="capabilitiesLoading || reserved"
        />
      </div>
    </div>
    <USwitch
      v-if="isAdmin && !reserved"
      v-model="reviewRequired"
      :label="t('users.roleForm.reviewRequired')"
      :description="t('users.roleForm.reviewRequiredHelp')"
    />
    <label
      v-if="isAdmin && mode === 'create'"
      class="flex items-start gap-2 cursor-pointer"
    >
      <UCheckbox v-model="applyTotalbaseDefaults" />
      <span class="flex flex-col">
        <span class="text-sm">{{ t('users.roleForm.applyDefaults') }}</span>
        <span class="text-xs text-muted">{{ t('users.roleForm.applyDefaultsHelp') }}</span>
      </span>
    </label>
  </div>
</template>
