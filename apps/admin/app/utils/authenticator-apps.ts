/**
 * Authenticator apps to suggest when someone sets up MFA (Security.md §2.17) - any TOTP app works; these are
 * widely used ones, each linked to its maker's own page (store links change by country). Product names and
 * platforms read the same in every language.
 */
export interface AuthenticatorApp {
  name: string
  platforms: string
  url: string
}

export const AUTHENTICATOR_APPS: readonly AuthenticatorApp[] = [
  { name: 'Google Authenticator', platforms: 'Android, iOS', url: 'https://support.google.com/accounts/answer/1066447' },
  { name: 'Microsoft Authenticator', platforms: 'Android, iOS', url: 'https://www.microsoft.com/security/mobile-authenticator-app' },
  { name: 'Apple Passwords', platforms: 'iPhone, iPad, Mac', url: 'https://support.apple.com/120758' },
  { name: '1Password', platforms: 'Android, iOS, desktop', url: 'https://1password.com' },
  { name: 'Bitwarden Authenticator', platforms: 'Android, iOS', url: 'https://bitwarden.com/products/authenticator/' },
  { name: '2FAS', platforms: 'Android, iOS', url: 'https://2fas.com' },
  { name: 'Ente Auth', platforms: 'Android, iOS, desktop', url: 'https://ente.io/auth' },
  { name: 'Aegis', platforms: 'Android', url: 'https://getaegis.app' }
]
