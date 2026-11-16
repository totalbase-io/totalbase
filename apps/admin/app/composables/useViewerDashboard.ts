import type { Dashboard, DashboardVariable } from '~/types/dashboard'

/** An embed's identity also says how it looks and where its editable variables start (embed-dashboards.ts). */
export type ViewerDashboard = Omit<Dashboard, 'variables'> & {
  display?: { titled?: boolean, refreshSeconds?: number | null, allowExport?: boolean }
  startingValues?: Record<string, unknown>
  /** An embed of one widget (Dashboards.md §9.5): that card alone, filling the frame - no bar, no tabs, no grid. */
  widget?: string | null
}

/** The App's or a signed embed's client (useAppApi, useEmbedApi) - only its reads. */
interface DashboardReader {
  get: <T>(path: string) => Promise<{ data: T }>
}

/**
 * A published dashboard's identity and variables as a viewer reads them. The App's page (DashboardViewer.vue, its
 * header) and the cards (DashboardView.vue) read the same two under the same keys, so they share one fetch: one
 * definition of each `useAsyncData`, because Nuxt expects one handler per key (NUXT_E3004).
 */
export function useViewerDashboard(api: DashboardReader, cacheKey: MaybeRefOrGetter<string>, base: MaybeRefOrGetter<string>) {
  const dashboard = useAsyncData(
    () => `app-dashboard-${toValue(cacheKey)}`,
    () => api.get<ViewerDashboard>(toValue(base)).then(r => r.data)
  )
  const variables = useAsyncData(
    () => `app-dashboard-variables-${toValue(cacheKey)}`,
    () => api.get<DashboardVariable[]>(`${toValue(base)}/variables`).then(r => r.data),
    { default: (): DashboardVariable[] => [] }
  )
  return { dashboard, variables }
}
