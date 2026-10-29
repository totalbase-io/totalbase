/**
 * The ids the UUID and ULID fields generate (TUuidInput, TUlidInput - DataViews.md §16.1). Random bytes from `crypto.getRandomValues`,
 * which every browser has - `crypto.randomUUID` exists only in a secure context (HTTPS or localhost), and an
 * instance on a LAN may be served over plain HTTP. PostgreSQL checks what is written.
 */
function hex(bytes: Uint8Array): string {
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A random UUID (version 4). */
export function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return hex(bytes)
}

/** A time-ordered UUID (version 7, RFC 9562): the milliseconds since 1970 first - what PostgreSQL 18's uuidv7() makes. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return hex(bytes)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID: 26 characters of Crockford's base32 - 10 of time (milliseconds), 16 random - sortable as text. */
export function ulid(now: number = Date.now()): string {
  let time = ''
  let rest = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32]! + time
    rest = Math.floor(rest / 32)
  }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => CROCKFORD[b % 32]).join('')
  return time + random
}
