/**
 * A small text diff for the audit views' before/after (AuditDiff.vue): by
 * words and punctuation within one line - the part that changed gets the
 * stronger color, like a code review's intra-line highlight - and by lines
 * for a multi-line value (a JSON object, a long text). Longest common
 * subsequence over tokens; above MAX_CELLS of work it gives up (null) and
 * the caller highlights the whole line instead.
 */
export interface DiffSegment { text: string, changed: boolean }
export interface DiffLine { sign: '-' | '+' | ' ', text: string }

const MAX_CELLS = 250_000

/** Words, runs of whitespace and single punctuation marks - joined back they are the string. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []
}

/** Which tokens of `a` and of `b` belong to their longest common subsequence; null when too large to compute. */
function commonMask(a: string[], b: string[]): { inA: boolean[], inB: boolean[] } | null {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const inA = Array.from({ length: a.length }, () => false)
  const inB = Array.from({ length: b.length }, () => false)
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inA[i++] = true
      inB[j++] = true
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return { inA, inB }
}

function segments(tokens: string[], kept: boolean[]): DiffSegment[] {
  const out: DiffSegment[] = []
  tokens.forEach((text, index) => {
    const changed = !kept[index]
    const last = out[out.length - 1]
    if (last && last.changed === changed) last.text += text
    else out.push({ text, changed })
  })
  return out
}

/** The two sides of a one-line change, each split into kept and changed parts; null when too long to compare. */
export function diffWords(before: string, after: string): { before: DiffSegment[], after: DiffSegment[] } | null {
  const a = tokenize(before)
  const b = tokenize(after)
  const mask = commonMask(a, b)
  if (!mask) return null
  return { before: segments(a, mask.inA), after: segments(b, mask.inB) }
}

/** A unified diff of two multi-line texts: kept lines as context, removed before added. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const mask = commonMask(a, b)
  if (!mask) return [...a.map(text => ({ sign: '-' as const, text })), ...b.map(text => ({ sign: '+' as const, text }))]
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && !mask.inA[i]) out.push({ sign: '-', text: a[i++]! })
    else if (j < b.length && !mask.inB[j]) out.push({ sign: '+', text: b[j++]! })
    else {
      out.push({ sign: ' ', text: a[i]! })
      i++
      j++
    }
  }
  return out
}
