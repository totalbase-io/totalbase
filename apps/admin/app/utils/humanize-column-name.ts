/** "created_at" -> "Created At" - a wizard's default Title per column, editable from there on. Display-label formatting, not part of the shared widget catalog (@totalbase/tb-catalog), so it stays local to the admin app. */
export function humanizeColumnName(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
