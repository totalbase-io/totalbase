import type { Permission, Role } from '~/types/permission'

/** One of a role's members: the assignment row (its id removes it) and who holds it. */
export interface RoleMember {
  assignment: string
  user: string
}

const MAX_ROLES = 500

/** What a role write may carry. The access flags only for an administrator - the guardrail refuses them to anyone else. */
export type RoleWrite = Partial<Pick<Role, 'name' | 'description' | 'icon' | 'color' | 'active' | 'appAccess' | 'apiAccess' | 'homeDataview' | 'homeDashboard' | 'parent' | 'reviewRequired'>>

function rowOf({ appAccess, apiAccess, homeDataview, homeDashboard, reviewRequired, ...rest }: RoleWrite): Record<string, unknown> {
  return {
    ...rest,
    ...(reviewRequired !== undefined && { review_required: reviewRequired }),
    ...(appAccess !== undefined && { app_access: appAccess }),
    ...(apiAccess !== undefined && { api_access: apiAccess }),
    ...(homeDataview !== undefined && { home_dataview: homeDataview }),
    ...(homeDashboard !== undefined && { home_dashboard: homeDashboard })
  }
}

/** A roles row as the Data API returns it - a column the caller may not read is absent. */
function roleFromRow(row: Record<string, unknown>): Role {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description ?? null) as string | null,
    icon: (row.icon ?? null) as string | null,
    color: (row.color ?? null) as string | null,
    active: row.active !== false,
    reserved: row.reserved === true,
    adminAccess: row.admin_access === true,
    appAccess: row.app_access === true,
    apiAccess: row.api_access === true,
    homeDataview: (row.home_dataview ?? null) as string | null,
    homeDashboard: (row.home_dashboard ?? null) as string | null,
    createdAt: row.created_at as string,
    createdBy: (row.created_by ?? null) as string | null,
    parent: (row.parent ?? null) as string | null,
    reviewRequired: row.review_required === true
  }
}

/**
 * Roles and their members through the Data API (Security.md §9.3, §9.4)
 * - for administrators and delegated users alike: a
 * non-administrator sees the roles and columns their permissions allow,
 * and writes are checked by the same resolver plus the role guardrails
 * (only roles they created; assignments only for roles they created or
 * manage). What only an administrator does - access flags, permissions,
 * managers, the reserved roles - stays on the Admin API.
 */
/** What a role may be granted beyond row operations (roles_capabilities). */
export type Capability = 'TRANSACTIONS' | 'SEND_EMAIL' | 'MANAGE_ROLES'

/** An attestation that a role's members were reviewed (roles_reviews, Security.md §1.8). */
export interface AccessReview {
  id: string
  outcome: 'NO_CHANGES' | 'CHANGES_MADE'
  note: string | null
  createdAt: string
  reviewer: { name: string | null, email: string } | null
  members: { id: string, email: string, name: string | null }[]
}

export function useRolesApi() {
  const dataApi = useDataApi()
  const rolesPath = dataApi.resourcePath('totalbase', 'roles')
  const assignmentsPath = dataApi.resourcePath('totalbase', 'users_roles')
  const capabilitiesPath = dataApi.resourcePath('totalbase', 'roles_capabilities')

  return {
    list: async (): Promise<Role[]> =>
      (await dataApi.get<Array<Record<string, unknown>>>(rolesPath, { order_by: 'name', limit: MAX_ROLES })).data.map(roleFromRow),
    get: async (id: string): Promise<Role | null> => {
      const row = (await dataApi.get<Array<Record<string, unknown>>>(rolesPath, { 'where[id][_eq]': id, 'limit': 1 })).data[0]
      return row ? roleFromRow(row) : null
    },
    create: async (body: RoleWrite): Promise<Role> =>
      roleFromRow((await dataApi.post<Record<string, unknown>>(rolesPath, { data: rowOf(body) })).data),
    update: async (id: string, patch: RoleWrite): Promise<Role> =>
      roleFromRow((await dataApi.patch<Record<string, unknown>>(`${rolesPath}/${id}`, { data: rowOf(patch) })).data),
    remove: async (id: string): Promise<void> => {
      await dataApi.del(`${rolesPath}/${id}`)
    },

    /** A page of the role's members; `userIds` narrows it (a user search's matches). */
    listMembers: async (roleId: string, options: { offset: number, limit: number, userIds?: string[] }): Promise<{ members: RoleMember[], total: number }> => {
      const { data, meta } = await dataApi.get<Array<{ id: string, user: string }>>(assignmentsPath, {
        'where[role][_eq]': roleId,
        ...(options.userIds && { 'where[user][_in]': options.userIds.join(',') }),
        'fields': 'id,user',
        'order_by': 'id',
        'limit': options.limit,
        'offset': options.offset,
        'count': true
      })
      return { members: data.map(row => ({ assignment: row.id, user: row.user })), total: (meta?.count as number | undefined) ?? data.length }
    },
    /** When each of these users' assignment to the role ends (Security.md §1.10) - users without an expiry are absent. */
    expiries: async (roleId: string, userIds: string[]): Promise<Map<string, string>> => {
      if (userIds.length === 0) return new Map()
      const { data } = await dataApi.get<Array<{ user: string, expires_at: string | null }>>(assignmentsPath, {
        'where[role][_eq]': roleId,
        'where[user][_in]': userIds.join(','),
        'fields': 'user,expires_at',
        'limit': userIds.length
      })
      return new Map(data.filter(row => row.expires_at).map(row => [row.user, row.expires_at!]))
    },
    addMember: async (roleId: string, userId: string): Promise<void> => {
      await dataApi.post(assignmentsPath, { data: { role: roleId, user: userId } })
    },
    removeMember: async (assignmentId: string): Promise<void> => {
      await dataApi.del(`${assignmentsPath}/${assignmentId}`)
    },
    /**
     * Bulk role membership (Security.md §9.4): one Data API
     * request each, so one transaction with an audit row per assignment.
     * Adding skips users who already hold the role (ON CONFLICT DO NOTHING).
     */
    addMembers: async (roleId: string, userIds: string[]): Promise<void> => {
      if (userIds.length === 0) return
      await dataApi.post(assignmentsPath, {
        data: userIds.map(user => ({ role: roleId, user })),
        on_conflict: { target: ['user', 'role'], action: 'NOTHING' }
      }, { bulk: true })
    },
    removeMembers: async (roleId: string, userIds: string[]): Promise<void> => {
      if (userIds.length === 0) return
      await dataApi.del(assignmentsPath, { 'where[role][_eq]': roleId, 'where[user][_in]': userIds.join(',') })
    },
    /** Into `toRoleId` first, then out of `fromRoleId` - a failure in between leaves them in both, never in neither. */
    moveMembers: async (fromRoleId: string, toRoleId: string, userIds: string[]): Promise<void> => {
      if (userIds.length === 0) return
      await dataApi.post(assignmentsPath, {
        data: userIds.map(user => ({ role: toRoleId, user })),
        on_conflict: { target: ['user', 'role'], action: 'NOTHING' }
      }, { bulk: true })
      await dataApi.del(assignmentsPath, { 'where[role][_eq]': fromRoleId, 'where[user][_in]': userIds.join(',') })
    },

    /** A role's data permissions (permissions) - written through the Admin API, which validates the filter grammar. */
    permissions: async (roleId: string): Promise<Permission[]> =>
      (await dataApi.getAll<Record<string, unknown>>(dataApi.resourcePath('totalbase', 'permissions'), { 'where[role][_eq]': roleId })).map(row => ({
        id: row.id as string,
        role: row.role as string,
        resource: row.resource as string,
        action: row.action as Permission['action'],
        effect: row.effect as Permission['effect'],
        whereClause: (row.where_clause ?? null) as Permission['whereClause'],
        fields: (row.field_overrides ?? []) as Permission['fields'],
        payloadChecks: (row.payload_checks ?? []) as Permission['payloadChecks']
      })),
    /** A role's capability (roles_capabilities, Security.md §5.2): its ALLOW/DENY row, or null without one. */
    capabilityGrant: async (roleId: string, capability: Capability): Promise<'ALLOW' | 'DENY' | null> =>
      (await dataApi.get<Array<{ effect: 'ALLOW' | 'DENY' }>>(capabilitiesPath, { 'where[role][_eq]': roleId, 'where[capability][_eq]': capability, 'fields': 'effect', 'limit': 1 })).data[0]?.effect ?? null,
    /**
     * "Can run transactions", "Can send email" - administrators only (the
     * guardrail refuses anyone else). On: an ALLOW row (a DENY one becomes
     * ALLOW). Off: no row.
     */
    setCapabilityAllowed: async (roleId: string, capability: Capability, allowed: boolean, current: 'ALLOW' | 'DENY' | null): Promise<void> => {
      // The row is addressed by its own id; (role, capability) is only its unique key.
      const rowPath = async () => {
        const row = (await dataApi.get<Array<{ id: string }>>(capabilitiesPath, { 'where[role][_eq]': roleId, 'where[capability][_eq]': capability, 'fields': 'id', 'limit': 1 })).data[0]
        return row ? `${capabilitiesPath}/${row.id}` : null
      }
      if (!allowed) {
        const path = current !== null ? await rowPath() : null
        if (path) await dataApi.del(path)
      } else if (current === 'DENY') {
        const path = await rowPath()
        if (path) await dataApi.patch(path, { data: { effect: 'ALLOW' } })
      } else if (current === null) {
        await dataApi.post(capabilitiesPath, { data: { role: roleId, capability, effect: 'ALLOW' } })
      }
    },
    /** A role's access reviews, newest first (Security.md §1.8). */
    accessReviews: async (roleId: string, limit = 20): Promise<AccessReview[]> =>
      (await dataApi.get<Array<Record<string, unknown>>>(dataApi.resourcePath('totalbase', 'roles_reviews'), {
        'where[role][_eq]': roleId,
        'fields': 'id,outcome,note,created_at,members,reviewer.name,reviewer.email',
        'order_by': '-created_at',
        limit
      })).data.map(row => ({
        id: row.id as string,
        outcome: row.outcome as AccessReview['outcome'],
        note: (row.note as string | null) ?? null,
        createdAt: row.created_at as string,
        // Related fields come back flat ("reviewer.email"); a deleted reviewer leaves them null.
        reviewer: row['reviewer.email'] ? { name: (row['reviewer.name'] as string | null) ?? null, email: row['reviewer.email'] as string } : null,
        members: (row.members as AccessReview['members']) ?? []
      })),
    /** Records a review - administrators only; PostgreSQL fills in the reviewer and the members. */
    recordAccessReview: async (roleId: string, outcome: AccessReview['outcome'], note: string): Promise<void> => {
      await dataApi.post(dataApi.resourcePath('totalbase', 'roles_reviews'), { data: { role: roleId, outcome, ...(note ? { note } : {}) } })
    },
    /** The roles whose members may assign `roleId` (roles_managers). */
    managers: async (roleId: string): Promise<string[]> =>
      (await dataApi.getAll<{ manager: string }>(dataApi.resourcePath('totalbase', 'roles_managers'), { 'where[role][_eq]': roleId, 'fields': 'manager' })).map(row => row.manager),
    /** The roles granted object access to a DataView or a Dashboard (Security.md §7.1). */
    grantedOn: async (kind: 'dataview' | 'dashboard', id: string): Promise<string[]> =>
      (await dataApi.getAll<{ role: string }>(dataApi.resourcePath('totalbase', `${kind}s_roles`), { [`where[${kind}][_eq]`]: id, fields: 'role' })).map(row => row.role)
  }
}
