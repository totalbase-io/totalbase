// Client-side secure password generator for the "New user" form's
// Generate button. Uses the Web Crypto RNG (not Math.random - not
// suitable for anything security-sensitive), and guarantees at least one
// character from each class rather than trusting a big enough length to
// make that statistically likely.
const LOWER = 'abcdefghijkmnpqrstuvwxyz' // no l/o - visually ambiguous with 1/0
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O
const DIGITS = '23456789' // no 0/1
const SYMBOLS = '!@#$%^&*-_=+'
const ALL = LOWER + UPPER + DIGITS + SYMBOLS

function randomChar(charset: string): string {
  const bytes = new Uint32Array(1)
  crypto.getRandomValues(bytes)
  return charset[bytes[0]! % charset.length]!
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const bytes = new Uint32Array(1)
    crypto.getRandomValues(bytes)
    const j = bytes[0]! % (i + 1)
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

export function generatePassword(length = 16): string {
  const required = [randomChar(LOWER), randomChar(UPPER), randomChar(DIGITS), randomChar(SYMBOLS)]
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => randomChar(ALL))
  return shuffle([...required, ...rest]).join('')
}
