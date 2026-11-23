import type { ColorMode, LoginCardPosition, LoginLayout } from '@totalbase/shared'

/** What GET /api/instance says about this instance - public, read once at boot (plugins/instance.client.ts). */
export interface InstanceInfo {
  language: string
  name: string
  /** The operator's mark (Admin_UI.md §4.1.1), or null for the built-in one. */
  logoUrl: string | null
  /** The color mode of a browser whose viewer hasn't picked one (useColorModeChoice). */
  colorMode: ColorMode
  login: {
    layout: LoginLayout
    cardPosition: LoginCardPosition
    backgroundUrl: string | null
    headline: string
    intro: string
    /** The auth providers shown on the sign-in page, each with where its button leads. */
    providers: SignInProvider[]
  }
  /** Lockdown (Security.md §2.21): on until turned off (`active` with no `from`/`until`), or by its scheduled window - `from`/`until`: the one running now, else the next one ahead. */
  lockdown: { active: boolean, mode: 'FULL' | 'READ_ONLY', from: string | null, until: string | null, message: string, noticeMinutes: number }
}

export interface SignInProvider {
  slug: string
  name: string
  type: 'GOOGLE' | 'GITHUB' | 'OIDC'
  signInUrl: string
}

export const PRODUCT_NAME = 'TotalBase'

const DEFAULT_INSTANCE: InstanceInfo = {
  language: 'en',
  name: PRODUCT_NAME,
  logoUrl: null,
  colorMode: 'SYSTEM',
  login: { layout: 'SPLIT', cardPosition: 'RIGHT', backgroundUrl: null, headline: '', intro: '', providers: [] },
  lockdown: { active: false, mode: 'FULL', from: null, until: null, message: '', noticeMinutes: 0 }
}

/** The instance's name, mark and sign-in layout (§4.1.1) - the defaults until the plugin has read them. */
export function useInstance() {
  const instance = useState<InstanceInfo>('instance', () => structuredClone(DEFAULT_INSTANCE))
  async function refresh() {
    const { data } = await $fetch<{ data: InstanceInfo }>('/api/instance', { baseURL: '' })
    instance.value = data
  }
  return { instance, refresh }
}
