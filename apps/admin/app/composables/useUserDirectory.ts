/**
 * Id -> name/email for users shown by reference (a token's owner, a
 * session's user, a file's author, an audit entry's principal), without
 * ever loading the whole user list: `ensure(ids)` fetches only the ids not
 * cached yet, in batches of 100. One cache for the whole portal session
 * (useState), so each user is looked up once.
 *
 * Read through the Data API (users, exposed by default), for
 * administrators and delegated users alike: a non-administrator sees only
 * the users and columns their permissions allow - no `fields` param, so a
 * column they may not read is left out instead of failing the lookup.
 */
interface DirectoryEntry {
  name: string | null
  email: string | null
  avatarUrl?: string | null
  /** Looked up, but no such user - deleted since it was referenced. */
  missing?: boolean
  /** Not readable by this viewer (a delegated user's permissions) - shown as "Another user", never a uuid. */
  hidden?: boolean
}

const BATCH = 100
// Module-level: two components asking for the same id at once share one request.
const inFlight = new Set<string>()

export function useUserDirectory() {
  const dataApi = useDataApi()
  const session = useSession()
  const { t } = useI18n()
  const entries = useState<Record<string, DirectoryEntry>>('user-directory', () => ({}))

  async function ensure(ids: Array<string | null | undefined>): Promise<void> {
    const missing = [...new Set(ids.filter((id): id is string => !!id))]
      .filter(id => !(id in entries.value) && !inFlight.has(id))
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      batch.forEach(id => inFlight.add(id))
      try {
        const { data } = await dataApi.get<Array<{ id: string, name?: string | null, email?: string | null, avatar_url?: string | null }>>(
          dataApi.resourcePath('totalbase', 'users'),
          { 'where[id][_in]': batch.join(','), 'limit': BATCH }
        )
        const next = { ...entries.value }
        for (const user of data) next[user.id] = { name: user.name ?? null, email: user.email ?? null, avatarUrl: user.avatar_url ?? null }
        // Only an administrator's lookup proves an absent id was deleted - a
        // delegated user's row filter may simply hide it.
        if (session.access.value === 'ADMIN') {
          for (const id of batch) next[id] ??= { name: null, email: null, missing: true }
        } else {
          for (const id of batch) next[id] ??= { name: null, email: null, hidden: true }
        }
        entries.value = next
      } catch {
        // No READ on users at all: every id of the batch is someone this viewer may not see.
        const next = { ...entries.value }
        for (const id of batch) next[id] ??= { name: null, email: null, hidden: true }
        entries.value = next
      } finally {
        batch.forEach(id => inFlight.delete(id))
      }
    }
  }

  /** Display label - name, else email; "Deleted user" once a lookup found none; the raw id until then. */
  function label(id: string | null | undefined, fallback = '—'): string {
    if (!id) return fallback
    const entry = entries.value[id]
    if (entry?.missing) return t('users.directory.deletedUser', { id: id.slice(0, 8) })
    // Oneself, always; anyone this viewer may not read, never as a uuid (T63).
    if (entry?.hidden) return id === session.admin.value?.id ? (session.admin.value?.name || session.admin.value?.email || t('users.directory.anotherUser')) : t('users.directory.anotherUser')
    return entry?.name || entry?.email || id
  }

  function email(id: string | null | undefined): string | null {
    return id ? entries.value[id]?.email ?? null : null
  }

  function avatar(id: string | null | undefined): string | null {
    return id ? entries.value[id]?.avatarUrl ?? null : null
  }

  return { ensure, label, email, avatar, entries }
}
