/**
 * Groups a newest-first list into bursts: consecutive items with the same
 * signature, each within `gapMs` of the one before it in the list (the
 * next one in time). A chain, not a window - a burst lasts as long as its
 * items keep coming. Status' latest configuration changes read a log this
 * way (StatusChanges.vue): thirty saves of one setting are one row.
 */
export function groupBursts<T>(items: T[], signature: (item: T) => string, time: (item: T) => number, gapMs: number): T[][] {
  const groups: Array<{ signature: string, items: T[] }> = []
  for (const item of items) {
    const key = signature(item)
    const last = groups.at(-1)
    if (last && last.signature === key && time(last.items.at(-1)!) - time(item) <= gapMs) last.items.push(item)
    else groups.push({ signature: key, items: [item] })
  }
  return groups.map(group => group.items)
}

/**
 * Groups a list by signature wherever its items are, in the order each
 * signature first appears - Status' latest sign-ins: a day's sign-ins of one
 * person through one door from one device are one row.
 */
export function groupBySignature<T>(items: T[], signature: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = signature(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()]
}
