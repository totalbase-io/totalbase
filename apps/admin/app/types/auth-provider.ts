export type AuthProviderType = 'GOOGLE' | 'GITHUB' | 'OIDC'

export interface AuthProviderConfig {
  client_id: string
  /** References a key in totalbase.secrets - never the plaintext secret itself (created ahead of time under Settings > Secrets). */
  client_secret_key: string
  scopes?: string[]
  allowed_redirect_urls: string[]
  /** Assigned only to a brand-new user's first login through this provider - never touches an existing user's roles. */
  default_role_id?: string | null
  /** OIDC only - the issuer used to discover the provider's endpoints. */
  issuer?: string
}

export interface AuthProvider {
  id: string
  type: AuthProviderType
  name: string
  enabled: boolean
  /** Its button on the portal's sign-in page. */
  showOnSignIn: boolean
  configuration: AuthProviderConfig
  createdAt: string
  updatedAt: string
}
