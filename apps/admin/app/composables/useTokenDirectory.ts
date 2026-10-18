/**
 * Id -> name/owner for personal access tokens shown by reference - an
 * audit entry made with a token has the token's id as its principal
 * (principalType API_KEY), not the user's. Same shape as
 * useUserDirectory: `ensure(ids)` fetches only uncached ids, in batches
 * through the Data API (tokens), one cache for the whole admin session.
 * A deleted token never resolves - callers fall back to its short id.
 */
interface TokenEntry {
  name: string
  user: string
}

const BATCH = 100
const inFlight = new Set<string>()

export function useTokenDirectory() {
  const dataApi = useDataApi()
  const users = useUserDirectory()
  const { t } = useI18n()
  const entries = useState<Record<string, TokenEntry>>('token-directory', () => ({}))

  async function ensure(ids: Array<string | null | undefined>): Promise<void> {
    const missing = [...new Set(ids.filter((id): id is string => !!id))]
      .filter(id => !(id in entries.value) && !inFlight.has(id))
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      batch.forEach(id => inFlight.add(id))
      try {
        const { data } = await dataApi.get<Array<{ id: string } & TokenEntry>>(dataApi.resourcePath('totalbase', 'tokens'), {
          'where[id][_in]': batch.join(','),
          'fields': 'id,name,user',
          'limit': BATCH
        })
        const next = { ...entries.value }
        for (const token of data) next[token.id] = { name: token.name, user: token.user }
        entries.value = next
        void users.ensure(data.map(token => token.user))
      } catch {
        // Best-effort: an unresolved id just renders as its short form.
      } finally {
        batch.forEach(id => inFlight.delete(id))
      }
    }
  }

  /** "CI deploy · Ada" - the token's name and its owner; "API key 3f9a2c1b" when unknown or deleted. */
  function label(id: string): string {
    const entry = entries.value[id]
    return entry ? `${entry.name} · ${users.label(entry.user)}` : t('users.directory.apiKey', { id: id.slice(0, 8) })
  }

  /** Just the token's name - "3f9a2c1b" when unknown or deleted. */
  function name(id: string): string {
    return entries.value[id]?.name ?? id.slice(0, 8)
  }

  return { ensure, label, name }
}
