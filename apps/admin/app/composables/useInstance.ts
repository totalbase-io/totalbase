import type { LoginCardPosition, LoginLayout } from '@totalbase/shared'

/** What GET /api/instance says about this instance - public, read once at boot (plugins/instance.client.ts). */
export interface InstanceInfo {
  language: string
  name: string
  /** The operator's mark (Specification_Admin_UI.md §4.1.1), or null for the built-in one. */
  logoUrl: string | null
  login: {
    layout: LoginLayout
    cardPosition: LoginCardPosition
    backgroundUrl: string | null
    headline: string
    intro: string
    /** The auth providers shown on the sign-in page, each with where its button leads. */
    providers: SignInProvider[]
  }
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
  login: { layout: 'SPLIT', cardPosition: 'RIGHT', backgroundUrl: null, headline: '', intro: '', providers: [] }
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
