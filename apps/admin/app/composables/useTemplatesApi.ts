import type { TemplateKind, TemplateSummary } from '~/utils/templates'

/**
 * Templates for every portal user (Specification_Security.md §9.3):
 * read and written through the Data API (templates - only the
 * rows and columns the caller may use; the name and slug rules are
 * PostgreSQL CHECKs). An administrator uses the same
 * path and bypasses permissions as always. The PDF preview renders on
 * /app/api/templates/preview-pdf.
 */
export function useTemplatesApi() {
  const dataApi = useDataApi()
  const appApi = useAppApi()
  const path = dataApi.resourcePath('totalbase', 'templates')

  function toSummary(row: Record<string, unknown>): TemplateSummary {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description ?? null) as string | null,
      slug: row.slug as string,
      kind: row.kind as TemplateKind,
      content: row.content,
      defaultCc: (row.default_cc ?? null) as string[] | null,
      defaultBcc: (row.default_bcc ?? null) as string[] | null,
      defaultReplyTo: (row.default_reply_to ?? null) as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    } as TemplateSummary
  }

  /** What the service used to tidy before the CHECKs see it: trimmed name and slug, an empty description as none. */
  function normalized(body: Record<string, unknown>): Record<string, unknown> {
    const next = { ...body }
    for (const key of ['name', 'slug'] as const) {
      if (typeof next[key] === 'string') next[key] = (next[key] as string).trim()
    }
    if (typeof next.description === 'string') next.description = next.description.trim() || null
    return next
  }

  return {
    list: async (): Promise<TemplateSummary[]> => (await dataApi.get<Record<string, unknown>[]>(path, { order_by: 'name' })).data.map(toSummary),
    get: async (id: string): Promise<TemplateSummary> => toSummary((await dataApi.get<Record<string, unknown>>(`${path}/${id}`)).data),
    create: async (body: Record<string, unknown>): Promise<TemplateSummary> =>
      toSummary((await dataApi.post<Record<string, unknown>>(path, { data: normalized(body) })).data),
    update: async (id: string, body: Record<string, unknown>): Promise<TemplateSummary> =>
      toSummary((await dataApi.patch<Record<string, unknown>>(`${path}/${id}`, { data: normalized(body) })).data),
    remove: async (id: string): Promise<void> => {
      await dataApi.del(`${path}/${id}`)
    },
    previewPdf: (content: unknown): Promise<Blob> => appApi.postBlob('/templates/preview-pdf', { data: { content } })
  }
}
