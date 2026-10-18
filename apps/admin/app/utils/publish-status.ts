import { isValidColorValue, roleColorShade } from '~/types/permission'

/**
 * The versioning status (Specification.md §13.5) the DataViews,
 * Dashboards and Workflows sidebars show on each row's badge: green when
 * published and up to date (green = live, like the editors' Publish
 * button), amber with unpublished changes, gray when never published -
 * whose name is dimmed too. Tooltip and screen-reader text spell it out;
 * color alone is not the signal.
 */
export type PublishStatus = 'LIVE' | 'CHANGED' | 'DRAFT'

/**
 * `short` is the badge text (the sidebars are narrow); the badge's tooltip
 * gives `label`. Both in English; `labelKey`/`shortKey` are their i18n keys
 * - what a component shows: `t(meta.labelKey)`.
 */
export const PUBLISH_STATUS_META: Record<PublishStatus, { label: string, short: string, labelKey: string, shortKey: string, badge: 'success' | 'warning' | 'neutral', name: string }> = {
  LIVE: { label: 'Published', short: 'Live', labelKey: 'shell.publishStatus.live', shortKey: 'shell.publishStatus.liveShort', badge: 'success', name: 'text-default' },
  CHANGED: { label: 'Unpublished changes', short: 'Changes', labelKey: 'shell.publishStatus.changed', shortKey: 'shell.publishStatus.changedShort', badge: 'warning', name: 'text-default' },
  DRAFT: { label: 'Never published', short: 'Draft', labelKey: 'shell.publishStatus.draft', shortKey: 'shell.publishStatus.draftShort', badge: 'neutral', name: 'text-muted' }
}

export function publishStatus(item: { liveVersion?: number | null, hasUnpublishedChanges?: boolean }): PublishStatus {
  if (item.liveVersion == null) return 'DRAFT'
  return item.hasUnpublishedChanges ? 'CHANGED' : 'LIVE'
}

/** An object's own color (its identity) on its icon - inline, since the palette has more hues than the utility classes (roleColorShade). */
export function identityIconStyle(color: string | null | undefined, mode: string): { color: string } | undefined {
  if (!color || !isValidColorValue(color)) return undefined
  return { color: roleColorShade(color, mode === 'dark' ? 'dark' : 'light') }
}
