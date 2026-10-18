/**
 * "Chrome on Linux" from a raw User-Agent - enough to tell a user's
 * sessions apart, not a full parser (no dependency: browsers put their own
 * token last, so the checks run most-specific first). Scripts and HTTP
 * libraries read as themselves ("curl", "node"). The raw string stays
 * available to show on hover.
 */
export interface DeviceDescription {
  label: string
  icon: string
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari']
]

const SYSTEMS: Array<[RegExp, string]> = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux']
]

const CLIENTS: Array<[RegExp, string]> = [
  [/^curl\//i, 'curl'],
  [/^Wget\//i, 'Wget'],
  [/^PostmanRuntime\//, 'Postman'],
  [/^insomnia\//i, 'Insomnia'],
  [/^python-requests\/|^python-httpx\/|^aiohttp\//i, 'Python'],
  [/^node|^undici|^axios\//i, 'Node.js'],
  [/^Go-http-client\//, 'Go'],
  [/^okhttp\//i, 'OkHttp']
]

/**
 * `t` puts the label's words in the UI's language (a component's `useI18n().t`);
 * without it they read in English - browser, system and client names never change.
 */
export function describeUserAgent(userAgent: string | null | undefined, t?: (key: string, params?: Record<string, string>) => string): DeviceDescription {
  const unknown = t ? t('shell.userAgent.unknownDevice') : 'Unknown device'
  const ua = userAgent?.trim()
  if (!ua) return { label: unknown, icon: 'i-lucide-circle-help' }

  const client = CLIENTS.find(([pattern]) => pattern.test(ua))
  if (client) return { label: client[1], icon: 'i-lucide-terminal' }

  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1]
  const mobile = /Mobile|Android|iPhone|iPad/.test(ua)
  const label = browser && system
    ? (t ? t('shell.userAgent.browserOnSystem', { browser, system }) : `${browser} on ${system}`)
    : browser ?? system ?? ua.split(/[\s/]/)[0] ?? unknown
  return { label, icon: mobile ? 'i-lucide-smartphone' : 'i-lucide-monitor' }
}
