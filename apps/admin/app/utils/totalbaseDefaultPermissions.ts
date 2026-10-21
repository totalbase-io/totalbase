/** What POST /admin/api/roles/{id}/totalbase-defaults answers - the grants live on the server (apps/server totalbase-default-grants.ts), where the MCP tool applies the same ones. */
export interface ApplyTotalbaseDefaultsResult {
  applied: { table: string, action: string }[]
  /** Grants the role already had for a listed table and action - left as they were. */
  kept: { table: string, action: string }[]
  /** Listed tables with no ACTIVE resource on this instance. */
  missing: string[]
}

/** Applies the default permissions on TotalBase's own tables to one role (Security.md §10.5). */
export async function applyTotalbaseDefaultPermissions(api: ReturnType<typeof useAdminApi>, roleId: string): Promise<ApplyTotalbaseDefaultsResult> {
  return (await api.post<ApplyTotalbaseDefaultsResult>(`/roles/${roleId}/totalbase-defaults`)).data
}
