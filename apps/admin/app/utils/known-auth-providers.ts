import type { AuthProviderType } from '~/types/auth-provider'

/**
 * The "New provider" wizard's provider picker (step 1) and the dynamic
 * fields it shows in step 2. Purely a frontend convenience layer: whatever
 * gets picked here still resolves to one of the three types the backend
 * actually understands (baseType) - Google/GitHub are stored as their own
 * type, everything else is stored as plain OIDC with a computed issuer.
 * Adding a new OIDC-compliant provider to this list never requires a
 * backend change; see [[auth-provider.ts]] for the persisted shape.
 */
export interface KnownProviderField {
  key: string
  label: string
  description?: string
}

export interface KnownProviderDef {
  id: string
  label: string
  /** Iconify name, e.g. a simple-icons brand mark. */
  icon: string
  baseType: AuthProviderType
  /** Extra inputs collected in step 2 to compose the issuer - omitted for fixed-issuer or non-OIDC providers. */
  fields?: KnownProviderField[]
  /** Issuer that never changes for this provider (GitLab.com, Apple, Slack...). */
  fixedIssuer?: string
  /** Composes the issuer from step-2 field values, for providers whose issuer is account-specific. */
  buildIssuer?: (values: Record<string, string>) => string
}

export const knownAuthProviders: KnownProviderDef[] = [
  { id: 'google', label: 'Google', icon: 'i-simple-icons-google', baseType: 'GOOGLE' },
  { id: 'github', label: 'GitHub', icon: 'i-simple-icons-github', baseType: 'GITHUB' },
  {
    id: 'microsoft',
    label: 'Microsoft / Azure AD',
    icon: 'i-simple-icons-microsoftazure',
    baseType: 'OIDC',
    fields: [{ key: 'tenantId', label: 'Tenant ID', description: 'Use "common" to accept any Microsoft account, or a specific tenant GUID to restrict to one organization.' }],
    buildIssuer: v => `https://login.microsoftonline.com/${v.tenantId?.trim() || 'common'}/v2.0`
  },
  { id: 'gitlab', label: 'GitLab', icon: 'i-simple-icons-gitlab', baseType: 'OIDC', fixedIssuer: 'https://gitlab.com' },
  { id: 'apple', label: 'Apple', icon: 'i-simple-icons-apple', baseType: 'OIDC', fixedIssuer: 'https://appleid.apple.com' },
  { id: 'slack', label: 'Slack', icon: 'i-simple-icons-slack', baseType: 'OIDC', fixedIssuer: 'https://slack.com' },
  {
    id: 'okta',
    label: 'Okta',
    icon: 'i-simple-icons-okta',
    baseType: 'OIDC',
    fields: [{ key: 'domain', label: 'Okta domain', description: 'e.g. your-domain.okta.com' }],
    buildIssuer: v => `https://${(v.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  },
  {
    id: 'auth0',
    label: 'Auth0',
    icon: 'i-simple-icons-auth0',
    baseType: 'OIDC',
    fields: [{ key: 'domain', label: 'Auth0 domain', description: 'e.g. your-tenant.auth0.com' }],
    buildIssuer: v => `https://${(v.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  },
  {
    id: 'oidc_custom',
    label: 'Custom OIDC provider',
    icon: 'i-lucide-shield-check',
    baseType: 'OIDC',
    fields: [{ key: 'issuer', label: 'Issuer', description: 'e.g. https://issuer.example.com - its OpenID discovery document must be reachable at {issuer}/.well-known/openid-configuration.' }],
    buildIssuer: v => (v.issuer ?? '').trim()
  }
]

export function findKnownProvider(id: string | null): KnownProviderDef | undefined {
  return knownAuthProviders.find(p => p.id === id)
}

/** Best-effort match of an existing OIDC provider's issuer back to a known preset - its icon and label in the list. */
export function guessKnownProviderId(type: AuthProviderType, issuer: string | undefined): string {
  if (type === 'GOOGLE') return 'google'
  if (type === 'GITHUB') return 'github'
  const fixed = knownAuthProviders.find(p => p.fixedIssuer && p.fixedIssuer === issuer)
  if (fixed) return fixed.id
  if (issuer?.startsWith('https://login.microsoftonline.com/')) return 'microsoft'
  if (/\.okta(preview)?\.com$/.test(issuer ?? '')) return 'okta'
  if (/\.auth0\.com$/.test(issuer ?? '')) return 'auth0'
  return 'oidc_custom'
}
