/** One version in a pillar's history (Specification.md §13) - the summary every `…/versions` list returns. */
export interface VersionSummary {
  version: number
  publishedAt: string
  restoredFromVersion: number | null
  /** Who published it. */
  user?: string | null
  /** The publisher's note on what it changes (§13.3). */
  note?: string | null
}
