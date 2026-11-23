<script setup lang="ts">
/**
 * One of Status' feeds (Admin_UI.md §3.4) - a slideover over the audit
 * entries of `query`, read as a person would tell them: a burst of the same
 * thing (same event, same subject, same person; a change, each within ten
 * minutes of the one before, a sign-in, the same day, door, device and
 * outcome) is one row with its count, opening into its entries; each
 * row says what happened, not only that something did; days are headings,
 * rows carry the time. Two kinds, one reading:
 *
 * - `changes`: what was changed (a setting and its new value, an object by
 *   its name) and, small under it, who changed it;
 * - `sign-ins`: a day, then who signed in or tried to that day, as a person -
 *   picture, name and email (UUser; the account of a refused attempt too,
 *   looked up by the email tried) - with a traffic light of that day's
 *   attempts (gone through, denied, failed) and the time of the last; a person opens into that day's timeline, one point
 *   per attempt whatever its outcome: the time, what came of it, and the
 *   door, the browser, the system and the address as badges. A switch
 *   keeps only the refused ones.
 *
 * Presentation only - the log keeps every entry, and an entry still opens in full.
 */
import type { AuditLog } from '~/types/audit'
import type { AuditLogPivot } from '~/components/AuditLogEntrySlideover.vue'
import type { AuditLogQuery } from '~/composables/useAuditLogs'
import type { RouteLocationRaw } from 'vue-router'
import { groupBursts, groupBySignature } from '~/utils/group-bursts'
import { describeUserAgent } from '~/utils/user-agent'

const props = defineProps<{
  kind: 'changes' | 'sign-ins'
  query: AuditLogQuery
  title: string
  description: string
  emptyTitle: string
  /** Where the whole story is: the footer's button. */
  more: { label: string, icon: string, to: RouteLocationRaw }
}>()
const open = defineModel<boolean>('open', { required: true })

const api = useAdminApi()
const dates = useDateTimeFormat()
const { t, te } = useI18n()

/** Enough entries for a burst not to be all there is; the groups shown are capped apart. */
const ENTRIES = 100
const GROUPS = 20
/** Entries further apart than this are two moments, however alike. */
const BURST_MS = 10 * 60 * 1000
/** A person's timeline shows this many attempts, the newest; the rest are in Logs. */
const TIMELINE = 20

const display = useAuditLogDisplay()
const directory = useUserDirectory()
// Sign-ins: only those refused, asked of the log itself - a busy instance's hundred newest may all have gone through.
const onlyRefused = ref(false)
const query = computed<AuditLogQuery>(() => (props.kind === 'sign-ins' && onlyRefused.value ? { ...props.query, status: 'DENIED,FAILED' } : props.query))
const logs = useAuditLogs(() => query.value, ref(1), ref(ENTRIES))
watch(onlyRefused, () => logs.load())
watch(logs.rows, (list) => {
  display.ensureUsers(list)
  // A refused sign-in has no principal: its account is found by the email tried.
  if (props.kind === 'sign-ins') void directory.ensureEmails(list.map(log => display.target(log)?.text))
})
watch(open, (value) => {
  if (value) logs.load()
}, { immediate: true })

// A DataView, dashboard or workflow is named in the log by its id: their names, asked for once and only when an entry needs them.
const OBJECT_LISTS = { dataview: '/dataviews', dashboard: '/dashboards', workflow: '/workflows' } as const
type ObjectKind = keyof typeof OBJECT_LISTS
const names = reactive(new Map<string, string>())
const asked = new Set<ObjectKind>()
function objectId(log: AuditLog): { kind: ObjectKind, id: string } | null {
  const kind = auditEventName(log)?.split('.')[0]
  const id = (log.metadata as { params?: { id?: unknown } } | null)?.params?.id
  return kind && kind in OBJECT_LISTS && typeof id === 'string' ? { kind: kind as ObjectKind, id } : null
}
watch(logs.rows, async (list) => {
  const kinds = new Set(list.map(objectId).filter(o => o !== null).map(o => o.kind))
  for (const kind of kinds) {
    if (asked.has(kind)) continue
    asked.add(kind)
    try {
      const { data } = await api.get<Array<{ id: string, name: string }>>(OBJECT_LISTS[kind])
      for (const item of data) names.set(item.id, item.name)
    } catch {
      // Best-effort: the row keeps the id.
    }
  }
})
/** What the entry changed: the object's name where the log has only its id, else the log's own Target. */
function detail(log: AuditLog): string | null {
  const object = objectId(log)
  return (object && names.get(object.id)) ?? display.target(log)?.text ?? null
}

/**
 * What makes two entries the same change: what was changed, not what it was changed to - a setting switched back and
 * forth is one burst, so its settings' names count and their values don't.
 */
function subject(log: AuditLog): string {
  // A sign-in: the account tried - with the event and the outcome beside it in the signature, twelve refusals of one account are one row.
  if (props.kind === 'sign-ins') return display.target(log)?.text ?? display.principalLabel(log)
  if (auditEventName(log)?.startsWith('settings.')) {
    const group = (log.metadata as { params?: { group?: unknown } } | null)?.params?.group
    const payload = log.payload && typeof log.payload === 'object' ? Object.keys(log.payload).sort().join(',') : ''
    return `${String(group)}:${payload}`
  }
  return detail(log) ?? ''
}

// An icon per thing changed - the log's own are per action, and nearly every entry here is the one action (AUTH).
const KIND_ICON: Record<string, string> = {
  schema: 'i-lucide-table-properties',
  settings: 'i-lucide-sliders-horizontal',
  system_email: 'i-lucide-mail',
  secret: 'i-lucide-lock-keyhole',
  auth_provider: 'i-lucide-log-in',
  permission: 'i-lucide-shield-check',
  role: 'i-lucide-shield',
  assignment: 'i-lucide-shield',
  user: 'i-lucide-user',
  token: 'i-lucide-key-round',
  dataview: 'i-lucide-layout-panel-left',
  dashboard: 'i-lucide-layout-dashboard',
  dashboard_embed: 'i-lucide-code-xml',
  workflow: 'i-lucide-workflow'
}

/** A sign-in: who - the email tried, known even when refused - then how and, refused, why. */
function signInReason(log: AuditLog): string | null {
  const reason = (log.metadata as { reason?: unknown } | null)?.reason
  if (typeof reason !== 'string') return null
  return te(`users.insights.signIns.reasons.${reason}`) ? t(`users.insights.signIns.reasons.${reason}`) : reason
}
/** Which door: the Data API, the portal, a provider, the second step of either, a password due for a change. */
const SIGN_IN_DOOR: Record<string, string> = {
  'auth.login': 'api',
  'auth.portal_login': 'portal',
  'auth.oauth_login': 'oauth',
  'auth.mfa_verify': 'mfa',
  'auth.portal_mfa_verify': 'mfa',
  'auth.password_renew': 'passwordRenew',
  'auth.portal_password_renew': 'passwordRenew'
}
function signInDoor(log: AuditLog): string {
  const door = SIGN_IN_DOOR[auditEventName(log) ?? '']
  return door ? t(`shell.status.signIns.doors.${door}`) : display.actionLabel(log)
}

interface Person {
  name: string
  description?: string
  avatar: { src?: string, alt: string }
}
/** A user as UUser shows one: the picture and name the directory has, else what the entry itself says. */
function person(id: string | null, fallback: string, email?: string | null): Person {
  const name = id ? directory.label(id, fallback) : fallback
  return {
    name,
    ...(email && email !== name && { description: email }),
    avatar: { src: directory.avatar(id) ?? undefined, alt: name }
  }
}
/**
 * Who signed in or tried to: the session's user, else the account the email tried belongs to, else that email alone.
 * An email no account had when it was tried stands alone - an account that took it since is not who tried.
 */
function signInAccount(log: AuditLog): { id: string | null, email: string | null, unknown: boolean } {
  const email = display.target(log)?.text ?? null
  const unknown = (log.metadata as { reason?: unknown } | null)?.reason === 'unknown_email'
  const id = (['USER', 'ADMIN'].includes(log.principalType) ? log.principalId : null) ?? (unknown ? null : directory.idByEmail(email))
  return { id, email, unknown }
}
function signInPerson(log: AuditLog): Person {
  const { id, email } = signInAccount(log)
  return person(id, email ?? display.principalLabel(log), email)
}
/**
 * One person, whatever came of each attempt: the email - the entry's, else their account's - so an account since
 * deleted, which no email finds any more, still stands with the attempts refused on it; else the account, else nobody.
 */
function signInKey(log: AuditLog): string {
  const { id, email: tried, unknown } = signInAccount(log)
  const email = tried ?? (id ? directory.email(id) : null)
  return email ? `${unknown ? 'unknown' : 'email'}:${email.toLowerCase()}` : id ? `id:${id}` : 'anonymous'
}
const hasAccount = (log: AuditLog) => ['USER', 'ADMIN'].includes(log.principalType) && !!log.principalId
/** Who made a change: a user with their picture; a token or the system by its name. */
function author(log: AuditLog): Person {
  return person(['USER', 'ADMIN'].includes(log.principalType) ? log.principalId : null, display.principalLabel(log))
}

function deviceParts(log: AuditLog) {
  const device = describeUserAgent(log.userAgent, t)
  const parts = [device.browser, device.system].filter((part): part is string => !!part)
  return { label: device.label, icon: device.icon, parts: parts.length ? parts : [device.label] }
}

const OUTCOMES = [{ status: 'EXECUTED', color: 'success' }, { status: 'DENIED', color: 'warning' }, { status: 'FAILED', color: 'error' }] as const

interface ChangeGroup {
  key: string
  entries: AuditLog[]
  /** A change: what it is and what about it. */
  label: string
  detail: string | null
  /** Who: the one who signed in or tried to, or a change's author. */
  person: Person
  /** A change: DENIED or FAILED, in words; null when it went through. */
  problem: string | null
  problemColor: ReturnType<typeof auditStatusColor>
  /** A person's sign-ins as a traffic light: how many went through, were denied, failed - only those there are. */
  outcomes: Array<{ status: string, count: number, color: 'success' | 'warning' | 'error', label: string }>
  icon: string
  time: string
}
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: dates.timezone.value })
const groups = computed<ChangeGroup[]>(() => {
  const signature = (log: AuditLog) => [auditEventName(log) ?? log.action, subject(log), log.principalType, log.principalId, log.status, dayKey(log.createdAt)].join('|')
  // Changes: bursts, the moment matters. Sign-ins: a day's of one person are one row, whatever came of each -
  // who was here today is what is read first; how, in the person's timeline.
  const grouped = props.kind === 'sign-ins'
    ? groupBySignature(logs.rows.value, log => `${dayKey(log.createdAt)}|${signInKey(log)}`)
    : groupBursts(logs.rows.value, signature, log => new Date(log.createdAt).getTime(), BURST_MS)
  return grouped.slice(0, GROUPS).map((entries) => {
    const newest = entries[0]!
    const oldest = entries.at(-1)!
    return {
      key: newest.id,
      entries,
      label: display.actionLabel(newest),
      detail: detail(newest),
      // A person is named by an entry that has their account, when one of theirs does.
      person: props.kind === 'sign-ins' ? signInPerson(entries.find(hasAccount) ?? newest) : author(newest),
      problem: newest.status === 'EXECUTED' ? null : t(`audit.statuses.${newest.status}`),
      problemColor: auditStatusColor(newest.status),
      outcomes: OUTCOMES.map(({ status, color }) => {
        const count = entries.filter(entry => entry.status === status).length
        return { status, count, color, label: t(`shell.status.signIns.outcomes.${status}`, { count }, count) }
      }).filter(outcome => outcome.count > 0),
      icon: KIND_ICON[auditEventName(newest)?.split('.')[0] ?? ''] ?? display.actionIcon.get(newest.action) ?? 'i-lucide-history',
      // A burst says from when to when.
      // A burst of changes says from when to when; a person's sign-ins, the last one - a span would read as time signed in.
      time: props.kind === 'changes' && entries.length > 1 && dates.time(oldest.createdAt) !== dates.time(newest.createdAt) ? `${dates.time(oldest.createdAt)} – ${dates.time(newest.createdAt)}` : dates.time(newest.createdAt)
    }
  })
})
// The groups under a heading per day, in the viewer's zone: Today, Yesterday, then the date.
const days = computed(() => {
  const today = dayKey(new Date().toISOString())
  const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  const result: Array<{ key: string, label: string, groups: ChangeGroup[] }> = []
  for (const group of groups.value) {
    const created = group.entries[0]!.createdAt
    const key = dayKey(created)
    if (result.at(-1)?.key !== key) {
      result.push({
        key,
        label: key === today ? t('shell.status.changes.today') : key === yesterday ? t('shell.status.changes.yesterday') : dates.date(created, { weekday: 'long', day: 'numeric', month: 'long' }),
        groups: []
      })
    }
    result.at(-1)!.groups.push(group)
  }
  return result
})

const expanded = ref(new Set<string>())
const opened = ref<AuditLog | null>(null)
/** One change opens in full; a burst opens into its entries first, a person always into their timeline. */
function select(group: ChangeGroup) {
  if (props.kind === 'changes' && group.entries.length === 1) {
    opened.value = group.entries[0]!
    return
  }
  const next = new Set(expanded.value)
  if (!next.delete(group.key)) next.add(group.key)
  expanded.value = next
}
/** That day's sign-ins in Logs - everyone's: the log filters by account, and a refused attempt has none. */
function dayInLogs(group: ChangeGroup): RouteLocationRaw {
  const day = dayKey(group.entries[0]!.createdAt)
  return { path: '/logs', query: { range: 'custom', from: day, to: day, event: props.query.event } }
}
/** A person's day as a timeline: a point per attempt, in the color of what came of it. */
function timeline(group: ChangeGroup) {
  return group.entries.slice(0, TIMELINE).map((log) => {
    const ok = log.status === 'EXECUTED'
    const color = auditStatusColor(log.status)
    return {
      value: log.id,
      log,
      time: dates.time(log.createdAt),
      icon: ok ? 'i-lucide-check' : 'i-lucide-x',
      tone: ok ? 'text-success' : color === 'warning' ? 'text-warning' : 'text-error',
      outcome: ok ? t('shell.status.signIns.signedIn') : signInReason(log) ?? t(`audit.statuses.${log.status}`),
      door: signInDoor(log),
      device: deviceParts(log),
      ip: log.ip
    }
  })
}
async function pivot(patch: AuditLogPivot) {
  opened.value = null
  await navigateTo({ path: '/logs', query: { range: 'all', ...patch } })
}

defineExpose({ refresh: () => open.value ? logs.load() : Promise.resolve() })
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="title"
    :description="description"
  >
    <template #body>
      <USwitch
        v-if="kind === 'sign-ins'"
        v-model="onlyRefused"
        :label="t('shell.status.signIns.onlyRefused')"
        size="sm"
        class="mb-4"
      />
      <UAlert
        v-if="logs.error.value"
        color="error"
        variant="subtle"
        :title="t('shell.status.feedFailed')"
      />
      <UEmpty
        v-else-if="!logs.pending.value && groups.length === 0"
        variant="naked"
        size="sm"
        icon="i-lucide-history"
        :title="emptyTitle"
      />
      <div
        v-else
        class="flex flex-col gap-4"
      >
        <section
          v-for="day in days"
          :key="day.key"
          class="flex flex-col"
        >
          <h3 class="pb-1 text-xs font-medium text-muted first-letter:uppercase">
            {{ day.label }}
          </h3>
          <!-- Each row in its own border; what it opens into stays inside it. -->
          <div class="flex flex-col gap-2 pt-1">
            <div
              v-for="group in day.groups"
              :key="group.key"
              class="overflow-hidden rounded-lg border border-default"
            >
              <!-- A person that day: who, how many times, how many refused, when. A div, not a button: UUser is a block. -->
              <div
                v-if="kind === 'sign-ins'"
                role="button"
                tabindex="0"
                class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm hover:bg-elevated/50"
                :aria-expanded="expanded.has(group.key)"
                @click="select(group)"
                @keydown.enter.prevent="select(group)"
                @keydown.space.prevent="select(group)"
              >
                <UUser
                  v-bind="group.person"
                  size="sm"
                  class="min-w-0 flex-1"
                />
                <UBadge
                  v-for="outcome in group.outcomes"
                  :key="outcome.status"
                  :label="String(outcome.count)"
                  :color="outcome.color"
                  :title="outcome.label"
                  :aria-label="outcome.label"
                  variant="subtle"
                  size="sm"
                  class="shrink-0 tabular-nums"
                />
                <UBadge
                  :label="group.time"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  class="shrink-0 tabular-nums"
                />
                <UIcon
                  :name="expanded.has(group.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="size-4 shrink-0 text-dimmed"
                />
              </div>
              <!-- A change: what it is, what about it, then when and - small - who. -->
              <div
                v-else
                role="button"
                tabindex="0"
                class="flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm hover:bg-elevated/50"
                :aria-expanded="group.entries.length > 1 ? expanded.has(group.key) : undefined"
                @click="select(group)"
                @keydown.enter.prevent="select(group)"
                @keydown.space.prevent="select(group)"
              >
                <UIcon
                  :name="group.icon"
                  class="mt-0.5 size-4 shrink-0"
                  :class="group.problem ? (group.problemColor === 'warning' ? 'text-warning' : 'text-error') : 'text-muted'"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="truncate text-highlighted">{{ group.label }}</span>
                    <UBadge
                      v-if="group.entries.length > 1"
                      :label="`×${group.entries.length}`"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      class="shrink-0"
                    />
                    <UBadge
                      v-if="group.problem"
                      :label="group.problem"
                      :color="group.problemColor"
                      variant="subtle"
                      size="sm"
                      class="shrink-0"
                    />
                  </div>
                  <p
                    v-if="group.detail"
                    class="truncate text-xs text-toned"
                  >
                    {{ group.detail }}
                  </p>
                  <div class="flex items-center gap-2 pt-1 text-xs text-muted">
                    <span class="shrink-0 tabular-nums">{{ group.time }}</span>
                    <UUser
                      v-bind="group.person"
                      size="3xs"
                      class="min-w-0"
                    />
                  </div>
                </div>
                <UIcon
                  v-if="group.entries.length > 1"
                  :name="expanded.has(group.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="mt-0.5 size-4 shrink-0 text-dimmed"
                />
              </div>
              <!-- A person's day: every attempt, gone through or refused, each opening in full. -->
              <UTimeline
                v-if="kind === 'sign-ins' && expanded.has(group.key)"
                :items="timeline(group)"
                size="3xs"
                color="neutral"
                class="border-t border-default px-4 pt-3"
                :ui="{ item: 'cursor-pointer pb-3', wrapper: 'min-w-0' }"
                @select="(_event: Event, item: { log: AuditLog }) => { opened = item.log }"
              >
                <template #indicator="{ item }">
                  <UIcon
                    :name="item.icon"
                    class="size-3.5"
                    :class="item.tone"
                  />
                </template>
                <template #title="{ item }">
                  <div class="flex items-baseline gap-2">
                    <span class="text-xs font-normal text-muted tabular-nums">{{ item.time }}</span>
                    <span :class="item.tone">{{ item.outcome }}</span>
                  </div>
                </template>
                <template #description="{ item }">
                  <div class="flex flex-wrap items-center gap-1.5 pt-1">
                    <UBadge
                      :label="item.door"
                      color="neutral"
                      variant="outline"
                      size="sm"
                    />
                    <UBadge
                      v-for="(part, index) in item.device.parts"
                      :key="part"
                      :label="part"
                      :icon="index === 0 ? item.device.icon : undefined"
                      :title="item.device.label"
                      color="neutral"
                      variant="outline"
                      size="sm"
                    />
                    <UBadge
                      v-if="item.ip"
                      :label="item.ip"
                      color="neutral"
                      variant="outline"
                      size="sm"
                      class="tabular-nums"
                    />
                  </div>
                </template>
              </UTimeline>
              <UButton
                v-if="kind === 'sign-ins' && expanded.has(group.key) && group.entries.length > TIMELINE"
                :label="t('shell.status.signIns.more')"
                :to="dayInLogs(group)"
                trailing-icon="i-lucide-arrow-right"
                color="neutral"
                variant="link"
                size="sm"
                class="mb-2 ms-8"
              />
              <!-- A burst's own entries: each opens in full. -->
              <div
                v-if="kind === 'changes' && group.entries.length > 1 && expanded.has(group.key)"
                class="flex flex-col border-t border-default py-1 ps-10"
              >
                <button
                  v-for="log in group.entries"
                  :key="log.id"
                  type="button"
                  class="flex items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-elevated/50"
                  @click="opened = log"
                >
                  <span class="min-w-0 flex-1 truncate text-toned">{{ detail(log) ?? display.actionLabel(log) }}</span>
                  <span class="shrink-0 text-muted tabular-nums">{{ dates.time(log.createdAt) }}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          :label="more.label"
          :icon="more.icon"
          color="neutral"
          variant="outline"
          :to="more.to"
        />
      </div>
    </template>
  </USlideover>
  <AuditLogEntrySlideover
    v-model="opened"
    :display="display"
    @pivot="pivot"
  />
</template>
