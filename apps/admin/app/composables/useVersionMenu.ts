import type { DropdownMenuItem } from '@nuxt/ui'
import type { VersionSummary } from '~/types/versioning'

/**
 * The versions menu's items (Foundations.md §13.7) - "Draft"
 * plus every version, newest first, the live one (always the highest)
 * marked Active. VersionsMenu.vue renders them as the editor header's
 * chip on desktop; `mobileMenu` is the same list as one submenu for
 * PageHeader's phone "⋮" (`mobile-menu`), where the chip doesn't fit.
 */
export function useVersionMenu(
  versions: MaybeRefOrGetter<VersionSummary[]>,
  viewing: MaybeRefOrGetter<number | null>,
  onSelect: (version: number | null) => void,
  /** "Delete old versions…" (Foundations.md §13.4) - offered once there is more than the live version. */
  onDeleteOld?: () => void
) {
  // Absolute dates/times in the user's zone and format (My account > Preferences).
  const dates = useDateTimeFormat()
  const { t } = useI18n()
  const liveVersion = computed(() => toValue(versions)[0]?.version ?? null)

  function build(activeBadge: boolean): DropdownMenuItem[][] {
    const current = toValue(viewing)
    return [
      [{
        label: t('common.draft'),
        description: t('shell.versions.draftDescription'),
        icon: 'i-lucide-pencil',
        type: 'checkbox' as const,
        checked: current === null,
        onSelect: () => onSelect(null)
      }],
      toValue(versions).map((v) => {
        const isLive = v.version === liveVersion.value
        const published = dates.dateTime(v.publishedAt, { dateStyle: 'medium', timeStyle: 'short' })
        return {
          label: `v${v.version}`,
          // The chip gives the live version its own `#active-trailing` slot (an
          // "Active" badge); a menu without that slot says it in the description.
          ...(isLive && activeBadge ? { slot: 'active' as const } : {}),
          description: [isLive && !activeBadge ? t('common.active') : '', published, v.restoredFromVersion ? t('shell.versions.restoredFrom', { version: v.restoredFromVersion }) : ''].filter(Boolean).join(' · '),
          type: 'checkbox' as const,
          checked: current === v.version,
          onSelect: () => onSelect(v.version)
        }
      }),
      ...(onDeleteOld && toValue(versions).length > 1
        ? [[{ label: t('shell.versions.deleteOld'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: onDeleteOld }]]
        : [])
    ]
  }

  const items = computed(() => build(true))
  const title = computed(() => (toValue(viewing) === null ? t('common.draft') : t('shell.versions.viewing', { version: toValue(viewing) })))
  const subtitle = computed(() => (toValue(versions).length === 0 ? t('shell.publishStatus.draft') : t('shell.versions.activeVersion', { version: liveVersion.value })))
  const mobileMenu = computed<DropdownMenuItem[][]>(() => [[{
    label: `${t('common.versions')} · ${title.value}`,
    description: subtitle.value,
    icon: 'i-lucide-git-commit-vertical',
    children: build(false)
  }]])

  return { items, liveVersion, title, subtitle, mobileMenu }
}
