import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { RoleAssignmentsService } from "@totalbase/permissions";
import { SecretsService } from "@totalbase/secrets";
import type { SettingsService } from "@totalbase/settings";
import type { AuthProvider } from "./auth-providers-service.js";
import { AuthProvidersService } from "./auth-providers-service.js";
import { resolveOAuthEndpoints } from "./oauth-endpoints.js";
import { exchangeCodeForTokens, fetchOAuthIdentity, type OAuthIdentity } from "./oauth-identity.js";
import { generateCodeVerifier, generateNonce, toCodeChallenge } from "./oauth-pkce.js";
import { assertRedirectAllowed } from "./oauth-redirect.js";
import { signOAuthState, verifyOAuthState } from "./oauth-state.js";
import type { MfaChallenge, MfaService } from "./mfa-service.js";
import { SessionsService } from "./sessions-service.js";
import { UsersService, type User } from "./users-service.js";

export type OAuthLoginResult =
  | {
      /** A second factor is due (Security.md §2.17): no session yet - the page completes the challenge. */
      mfa: MfaChallenge;
      token?: undefined;
      user: User;
      redirectTo: string;
      portal: boolean;
      error?: undefined;
    }
  | {
      mfa?: undefined;
      token: string;
      user: User;
      /** Validated at the start of the flow (assertRedirectAllowed) and carried through the signed state - the callback route redirects here with the session token, per spec: "the customer's own system receives the logged-in user, not TotalBase's admin". */
      redirectTo: string;
      /** Started from the portal's sign-in page - the route then requires portal access instead of API access. */
      portal: boolean;
      error?: undefined;
    }
  | {
      /**
       * `email_required`: the provider shared no email for a first sign-in -
       * every user needs one, so no account is created.
       * `access_denied`: the identity belongs to an account that can't sign
       * in - deactivated, or a system account (can_login = false, e.g. the
       * Workflows user) - so no session and no new link.
       * `email_not_verified`: auth.email_verification_required is on and
       * the account's email isn't verified - neither before nor by this
       * provider (Security.md §2.7). No session.
       */
      mfa?: undefined;
      error: "email_required" | "access_denied" | "email_not_verified";
      redirectTo: string;
      portal: boolean;
      /** The account refused, when there is one - for the audit row. */
      userId?: string;
    };

/** The matched account can't sign in (inactive, can_login = false, or locked out) - becomes `access_denied`, never a session. */
class AccountUnavailableError extends Error {}

/**
 * Orchestrates the browser-redirect OAuth/OIDC login flow
 * (Security.md §2.5) on top of AuthProvidersService (admin
 * configuration) and SessionsService (the same session issuance LOCAL
 * login uses - an OAuth-authenticated user is indistinguishable from a
 * LOCAL one to every other part of TotalBase once logged in).
 *
 * TotalBase is the *only* party that ever sees the provider's
 * client_secret or talks to its token endpoint - the caller's own
 * frontend only ever links to `start()`'s URL and reads a session token
 * back off its own `redirect_to`. See oauth-redirect.ts for the
 * allowlist that makes that handoff safe.
 */
export class OAuthService {
  constructor(
    private readonly database: Database,
    readonly providers: AuthProvidersService,
    private readonly secrets: SecretsService,
    private readonly settings: SettingsService,
    private readonly roleAssignments: RoleAssignmentsService,
    private readonly masterKey: string,
    /** The canonical public URL (`system.public_url`, else TOTALBASE_PUBLIC_URL) - read per call so a settings change applies without a restart. */
    private readonly resolvePublicUrl: () => Promise<string>,
    private readonly mfa?: MfaService,
  ) {}

  /** The callback URL registered with a provider - public so the admin can show it. */
  async redirectUriFor(slug: string): Promise<string> {
    return `${(await this.resolvePublicUrl()).replace(/\/$/, "")}/api/auth/oauth/${slug}/callback`;
  }

  /** The portal's own page that receives a provider sign-in (`#token=`), always an allowed redirect for a provider shown on the sign-in page. */
  async portalCallbackUrl(): Promise<string> {
    return `${(await this.resolvePublicUrl()).replace(/\/$/, "")}/auth/oauth`;
  }

  /** GET /api/auth/oauth/:provider - returns the URL to redirect the end user's browser to. */
  async start(slug: string, redirectTo: string): Promise<string> {
    const provider = await this.providers.findBySlugOrThrow(slug);
    if (!provider.enabled) {
      throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", `Auth provider is disabled: ${slug}`);
    }
    // The portal's sign-in page: TotalBase's own callback, for a provider an administrator shows there.
    const portal = redirectTo === (await this.portalCallbackUrl());
    if (portal) {
      if (!provider.showOnSignIn) throw new TotalBaseError("OAUTH_REDIRECT_NOT_ALLOWED", "This provider isn't shown on the sign-in page.");
    } else {
      assertRedirectAllowed(provider.configuration.allowed_redirect_urls, redirectTo);
    }

    const endpoints = await resolveOAuthEndpoints(provider);
    const codeVerifier = generateCodeVerifier();
    const nonce = generateNonce();
    const state = signOAuthState(this.masterKey, {
      provider: slug,
      codeVerifier,
      nonce,
      redirectTo,
      ...(portal && { portal: true }),
      issuedAt: Date.now(),
    });

    const url = new URL(endpoints.authorizationEndpoint);
    url.searchParams.set("client_id", provider.configuration.client_id);
    url.searchParams.set("redirect_uri", await this.redirectUriFor(slug));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (provider.configuration.scopes ?? endpoints.defaultScopes).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", toCodeChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (endpoints.jwks) url.searchParams.set("nonce", nonce); // OIDC/Google only - GitHub has no id_token to bind a nonce into.
    return url.toString();
  }

  /** GET /api/auth/oauth/:provider/callback - completes the flow and issues a TotalBase session. */
  /**
   * `admit` is the surface's access rule (API access, or portal access for the portal's own sign-in), checked
   * before a session or an MFA challenge exists: refused, the result is `access_denied`.
   */
  async callback(slug: string, code: string, state: string, admit?: (userId: string, portal: boolean) => Promise<boolean>): Promise<OAuthLoginResult> {
    const payload = verifyOAuthState(this.masterKey, state);
    if (payload.provider !== slug) {
      throw new TotalBaseError("INVALID_OAUTH_STATE", "This login attempt was started for a different provider.");
    }

    const provider = await this.providers.findBySlugOrThrow(slug);
    if (!provider.enabled) {
      throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", `Auth provider is disabled: ${slug}`);
    }

    const endpoints = await resolveOAuthEndpoints(provider);
    const clientSecret = await this.secrets.decrypt(provider.configuration.client_secret_key);
    const tokens = await exchangeCodeForTokens(endpoints.tokenEndpoint, {
      clientId: provider.configuration.client_id,
      clientSecret,
      code,
      redirectUri: await this.redirectUriFor(slug),
      codeVerifier: payload.codeVerifier,
    });

    const identity = await fetchOAuthIdentity(provider, endpoints, tokens, payload.nonce);
    let resolved: { user: User; isNewUser: boolean };
    try {
      resolved = await this.resolveUser(provider, identity);
    } catch (error) {
      // Back to the caller's own page with an error, like access_denied -
      // not a JSON error page in the user's browser.
      if (error instanceof TotalBaseError && error.code === "OAUTH_EMAIL_REQUIRED") {
        return { error: "email_required", redirectTo: payload.redirectTo, portal: payload.portal === true };
      }
      if (error instanceof AccountUnavailableError) {
        return { error: "access_denied", redirectTo: payload.redirectTo, portal: payload.portal === true };
      }
      throw error;
    }
    const { user, isNewUser } = resolved;

    if (isNewUser && provider.configuration.default_role_id) {
      await this.roleAssignments.assignRoleToUser(user.id, provider.configuration.default_role_id);
    }

    // A provider that verified this very address proves control of it, as
    // the verification link would. Otherwise an unverified account is
    // refused while verification is required - the same gate as a password
    // sign-in (AuthService.assertEmailVerified).
    const users = new UsersService(this.database);
    if (!user.emailVerifiedAt) {
      if (identity.emailVerified && identity.email && identity.email.toLowerCase() === user.email?.toLowerCase()) {
        await users.markEmailVerified(user.id);
      } else if (await this.settings.get("auth.email_verification_required")) {
        return { error: "email_not_verified", redirectTo: payload.redirectTo, portal: payload.portal === true, userId: user.id };
      }
    }

    const portal = payload.portal === true;
    if (admit && !(await admit(user.id, portal))) {
      return { error: "access_denied", redirectTo: payload.redirectTo, portal, userId: user.id };
    }
    // The account's second factor applies to a provider sign-in too (Security.md §2.17).
    const step = await this.mfa?.secondStep(user.id, portal ? "PORTAL" : "API");
    if (step) return { mfa: step, user, redirectTo: payload.redirectTo, portal };

    const ttlHours = await this.settings.get("auth.session_ttl_hours");
    const maxSessions = await this.settings.get("auth.max_sessions_per_user");
    const sessions = new SessionsService(this.database, this.settings);
    const { token } = await sessions.create({ user: user.id, ttlHours, maxSessionsPerUser: maxSessions });

    await users.touchLastLogin(user.id);

    return { token, user, redirectTo: payload.redirectTo, portal: payload.portal === true };
  }

  /**
   * Identity resolution order (spec-agreed): (1) an existing
   * (provider, subject) link - the common case on every login after the
   * first; (2) a verified email matching an existing user - links this
   * provider to that account rather than creating a duplicate; (3)
   * neither - a brand new user, OAuth-only (no password), tagged
   * isNewUser so the caller can apply the provider's default_role_id.
   * An existing user's roles are never touched by (1) or (2) - OAuth is
   * a login method here, not a permission grant. An account that can't
   * sign in (inactive, or can_login = false like the Workflows system
   * user, or locked out) is refused in (1) and never linked in (2): the same
   * accounts a password sign-in refuses, so a provider asserting their email
   * can't reach them either.
   */
  private async resolveUser(provider: AuthProvider, identity: OAuthIdentity): Promise<{ user: User; isNewUser: boolean }> {
    const resolved = await this.resolveUserIdentity(provider, identity);
    // The provider's picture becomes the avatar of a user who has none yet.
    if (identity.avatarUrl && !resolved.user.avatarUrl) {
      await new UsersService(this.database).setAvatarIfMissing(resolved.user.id, identity.avatarUrl);
    }
    return resolved;
  }

  private async resolveUserIdentity(provider: AuthProvider, identity: OAuthIdentity): Promise<{ user: User; isNewUser: boolean }> {
    const users = new UsersService(this.database);

    const { rows: existingIdentityRows } = await this.database.query<{ user: string }>(
      `SELECT "user" FROM totalbase.identities WHERE provider = $1 AND provider_subject = $2`,
      [provider.id, identity.subject],
    );
    if (existingIdentityRows[0]) {
      const user = await users.findById(existingIdentityRows[0].user);
      if (!user) {
        throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", "The user linked to this identity no longer exists.");
      }
      if (!(await this.canSignIn(users, user))) throw new AccountUnavailableError();
      await this.touchIdentity(provider.id, identity);
      return { user, isNewUser: false };
    }

    if (identity.email && identity.emailVerified) {
      const byEmail = await users.findByEmail(identity.email);
      if (byEmail) {
        if (!(await this.canSignIn(users, byEmail))) throw new AccountUnavailableError();
        await this.linkIdentity(byEmail.id, provider.id, identity);
        return { user: byEmail, isNewUser: false };
      }
    }

    // A first sign-in creates the account, and every account has an email:
    // a provider that shares none (an OIDC provider without the email
    // scope/claim) can't create one. An identity already linked above
    // still signs in without it.
    if (!identity.email) {
      throw new TotalBaseError("OAUTH_EMAIL_REQUIRED", "The provider didn't share an email address, which a new account needs.");
    }
    const created = await users.create({ email: identity.email, name: identity.username, passwordHash: null, emailVerified: identity.emailVerified });
    await this.linkIdentity(created.id, provider.id, identity);
    return { user: created, isNewUser: true };
  }

  /** The accounts a password sign-in refuses: inactive, can_login = false, or locked out. */
  private async canSignIn(users: UsersService, user: User): Promise<boolean> {
    return user.active && user.canLogin && !(await users.isLocked(user.id));
  }

  private async linkIdentity(userId: string, providerId: string, identity: OAuthIdentity): Promise<void> {
    await this.database.query(
      `INSERT INTO totalbase.identities
         ("user", provider, provider_subject, provider_email, provider_username, provider_avatar_url, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [userId, providerId, identity.subject, identity.email, identity.username, identity.avatarUrl],
    );
  }

  private async touchIdentity(providerId: string, identity: OAuthIdentity): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.identities
       SET provider_email = $3, provider_username = $4, provider_avatar_url = $5, last_login_at = now()
       WHERE provider = $1 AND provider_subject = $2`,
      [providerId, identity.subject, identity.email, identity.username, identity.avatarUrl],
    );
  }
}
