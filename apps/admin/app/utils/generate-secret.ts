/**
 * Random values for a secret (Settings › Secrets), from the browser's
 * cryptographic generator - nothing leaves the page until the secret is
 * saved. Sizes are bytes of randomness for the encoded kinds (what decides
 * strength), characters for the alphanumeric one.
 */
export type SecretKind = 'BASE64URL' | 'HEX' | 'ALPHANUMERIC' | 'UUID'

export const SECRET_KINDS: SecretKind[] = ['BASE64URL', 'HEX', 'ALPHANUMERIC', 'UUID']
export const SECRET_SIZES: number[] = [16, 32, 64]
export const DEFAULT_SECRET_SIZE = 32

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count))
}

/** How many characters a kind and size produce - the popover's hint. */
export function secretLength(kind: SecretKind, size: number): number {
  if (kind === 'UUID') return 36
  if (kind === 'HEX') return size * 2
  if (kind === 'BASE64URL') return Math.ceil((size * 4) / 3)
  return size
}

export function generateSecret(kind: SecretKind, size: number = DEFAULT_SECRET_SIZE): string {
  if (kind === 'UUID') return crypto.randomUUID()
  if (kind === 'HEX') return Array.from(randomBytes(size), b => b.toString(16).padStart(2, '0')).join('')
  if (kind === 'BASE64URL') {
    return btoa(String.fromCharCode(...randomBytes(size))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  // Alphanumeric: a byte only counts below the largest multiple of the
  // alphabet's size (248 for 62), so no character is likelier than another.
  const limit = 256 - (256 % ALPHANUMERIC.length)
  let out = ''
  while (out.length < size) {
    for (const byte of randomBytes(size)) {
      if (byte < limit && out.length < size) out += ALPHANUMERIC[byte % ALPHANUMERIC.length]
    }
  }
  return out
}
