import { describe, expect, it } from 'vitest'
import { describeUserAgent } from './user-agent'

describe('describeUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Chrome on Linux', 'i-lucide-monitor'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'Edge on Windows', 'i-lucide-monitor'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS', 'i-lucide-monitor'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on macOS', 'i-lucide-monitor'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iOS', 'i-lucide-smartphone'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'Chrome on Android', 'i-lucide-smartphone'],
    ['curl/8.5.0', 'curl', 'i-lucide-terminal'],
    ['node', 'Node.js', 'i-lucide-terminal']
  ])('%s → %s', (ua, label, icon) => {
    expect(describeUserAgent(ua)).toEqual({ label, icon })
  })

  it('handles a missing user agent', () => {
    expect(describeUserAgent(null).label).toBe('Unknown device')
  })
})
