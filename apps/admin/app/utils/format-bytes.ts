/** "10 MB", "1.5 GB" - binary units (1 KB = 1024 bytes), as PostgreSQL's own pg_size_pretty() uses. */
/** A bigint column (`size_bytes`) reaches the admin as its text: "1" is a number too. */
export function formatBytes(bytes: number | string): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`
}
