/**
 * The instance's lockdown as this page sees it (Security.md §2.21): GET /api/instance's `lockdown`, with the
 * scheduled window followed by the clock - it starts and ends without a reload. A display only: the server
 * decides every request.
 */
/** This browser's session exists and a lockdown keeps it out: set when the session is restored at boot and refused. */
export const useLockedOut = () => useState('lockdown-locked-out', () => false)

export function useLockdown() {
  const { instance } = useInstance()
  const { dateTime } = useDateTimeFormat()
  const { t } = useI18n()
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now()
    }, 30_000)
  })
  onUnmounted(() => clearInterval(timer))

  // A scheduled window is followed by the clock; with none, the lockdown is on until someone turns it off.
  const bounds = computed(() => {
    const { from, until } = instance.value.lockdown
    const start = from ? Date.parse(from) : NaN
    const end = until ? Date.parse(until) : NaN
    return Number.isNaN(start) || Number.isNaN(end) ? null : { from: start, until: end }
  })
  const window = computed(() => bounds.value && now.value < bounds.value.until ? { ...bounds.value, running: now.value >= bounds.value.from } : null)
  const active = computed(() => bounds.value ? window.value?.running === true : instance.value.lockdown.active)
  /** When it ends by itself: a running window. */
  const until = computed(() => window.value?.running ? dateTime(new Date(window.value.until)) : null)
  /** A window still ahead. */
  const scheduled = computed(() => window.value && !window.value.running
    ? { from: dateTime(new Date(window.value.from)), until: dateTime(new Date(window.value.until)) }
    : null)
  const message = computed(() => instance.value.lockdown.message)
  /** Read-only (`lockdown.mode`): everyone reads, only administrators change anything. */
  const readOnly = computed(() => instance.value.lockdown.mode === 'READ_ONLY')
  /** A window ahead its users are told of by now (`lockdown.notice_minutes` before it starts). */
  const notice = computed(() => {
    const minutes = instance.value.lockdown.noticeMinutes
    return scheduled.value && minutes > 0 && now.value >= window.value!.from - minutes * 60_000 ? scheduled.value : null
  })

  /** `lead`, then when it ends and the operator's message - one paragraph for whoever is kept out. */
  function text(lead: string): string {
    return [lead, until.value ? t('auth.lockdown.until', { time: until.value }) : '', message.value].filter(Boolean).join(' ')
  }

  return reactive({ active, readOnly, until, scheduled, notice, message, text })
}
