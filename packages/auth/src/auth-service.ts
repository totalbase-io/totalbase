import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { AuthTokensService } from "./auth-tokens-service.js";
import type { EmailSender } from "./email-sender.js";
import { SystemMailer, type SystemEmailRecipient } from "./system-mailer.js";
import { assertPasswordStrength, hashPassword, verifyPassword } from "./password.js";
import { SessionsService } from "./sessions-service.js";
import { UsersService } from "./users-service.js";
import type { User } from "./users-service.js";

export interface AuthServiceOptions {
  /** TOTALBASE_PUBLIC_URL - the base for email links while `system.public_url` is empty. */
  publicUrl?: string;
  /**
   * Receives failures of best-effort emails (security notices, welcome,
   * the public password-reset/registration sends) - the flow itself still
   * succeeds, so these are only worth logging.
   */
  onBackgroundError?: (error: unknown, context: string) => void;
}

/**
 * Why a sign-in was refused - for the audit log. The caller gets the same
 * generic 401 for every reason except `email_not_verified`, which is only
 * reached once the password matched (EMAIL_NOT_VERIFIED, 403).
 */
export type LoginFailureReason = "unknown_email" | "no_password" | "inactive" | "cannot_login" | "locked" | "wrong_password" | "email_not_verified";

/** How an admin-issued link reaches the person: emailed, or handed back to the admin to share. */
export type LinkDelivery = "email" | "link";

export interface LoginResult {
  token: string;
  user: User;
}

/**
 * Composes users/sessions/tokens/settings into the LOCAL authentication
 * flows described in Specification_Security.md §2.
 */
export class AuthService {
  readonly users: UsersService;
  readonly sessions: SessionsService;
  readonly authTokens: AuthTokensService;
  readonly mailer: SystemMailer;
  private readonly onBackgroundError: (error: unknown, context: string) => void;

  constructor(
    private readonly database: Database,
    private readonly settings: SettingsService,
    emailSender: EmailSender,
    options: AuthServiceOptions = {},
  ) {
    this.users = new UsersService(database);
    this.sessions = new SessionsService(database);
    this.authTokens = new AuthTokensService(database);
    this.mailer = new SystemMailer(settings, emailSender, options.publicUrl ?? "");
    this.onBackgroundError = options.onBackgroundError ?? (() => {});
  }

  /** The best-effort emails still going out. */
  private readonly pendingEmails = new Set<Promise<void>>();

  /**
   * Sends an email whose failure must not fail the surrounding flow - in the background: the flow has already done
   * its work, and a slow SMTP relay (minutes to refuse an address) must not hold its response. A failure is reported
   * to `onBackgroundError`.
   */
  private sendBestEffort(context: string, send: () => Promise<void>): void {
    const sending: Promise<void> = send()
      .catch((err: unknown) => this.onBackgroundError(err, context))
      .finally(() => this.pendingEmails.delete(sending));
    this.pendingEmails.add(sending);
  }

  /** Waits for the best-effort emails still going out - a graceful shutdown, a test reading what was sent. */
  async emailsSettled(): Promise<void> {
    while (this.pendingEmails.size > 0) await Promise.allSettled([...this.pendingEmails]);
  }

  /**
   * The security notice to the address an admin just replaced
   * (auth.email_changed_email_enabled) - best-effort: the change has
   * already committed, and a notice that can't go out mustn't undo it.
   */
  async notifyEmailChanged(previous: SystemEmailRecipient, newEmail: string): Promise<void> {
    if (!(await this.settings.get("auth.email_changed_email_enabled"))) return;
    this.sendBestEffort("email_changed email", () =>
      this.mailer.send("email_changed", previous, undefined, { new_email: newEmail }),
    );
  }

  private async notifyPasswordChanged(userId: string): Promise<void> {
    if (!(await this.settings.get("auth.password_changed_email_enabled"))) return;
    const user = await this.users.findById(userId);
    if (!user?.email) return;
    this.sendBestEffort("password_changed email", () =>
      this.mailer.send("password_changed", { email: user.email!, name: user.name }),
    );
  }

  private async sendWelcome(userId: string): Promise<void> {
    if (!(await this.settings.get("auth.welcome_email_enabled"))) return;
    const user = await this.users.findById(userId);
    if (!user?.email) return;
    this.sendBestEffort("user_welcome email", () =>
      this.mailer.send("user_welcome", { email: user.email!, name: user.name }),
    );
  }

  /** POST /api/auth/register. Gated by auth.registration_enabled. */
  async register(input: { email: string; password: string; name?: string }): Promise<User> {
    const registrationEnabled = await this.settings.get("auth.registration_enabled");
    if (!registrationEnabled) {
      throw new TotalBaseError("PERMISSION_DENIED", "Public registration is disabled.");
    }

    const minLength = await this.settings.get("auth.password_min_length");
    assertPasswordStrength(input.password, minLength);

    const passwordHash = await hashPassword(input.password);
    const defaultRole = await this.settings.get("auth.registration_default_role");
    // A duplicate email is PostgreSQL's unique index on lower(email) -
    // UsersService.create maps it to a 409, no pre-check (AGENTS.md 16).
    // The account and its default role commit together. The role is
    // re-checked here, not only when the setting was saved: a role deleted
    // since is simply not given, and a reserved or admin_access one never is.
    const user = await this.database.transaction(async (client) => {
      const created = await this.users.create({ email: input.email, name: input.name ?? null, passwordHash }, client);
      if (defaultRole) {
        await client.query(
          `INSERT INTO totalbase.users_roles ("user", role)
           SELECT $1, id FROM totalbase.roles WHERE id = $2 AND NOT reserved AND NOT admin_access`,
          [created.id, defaultRole],
        );
      }
      return created;
    });

    const verificationRequired = await this.settings.get("auth.email_verification_required");
    if (verificationRequired && user.email) {
      // Best-effort: the account already exists, so a mail failure here
      // must not surface as a failed registration (the person couldn't
      // retry - the email is taken). POST /api/auth/email/resend retries.
      this.sendBestEffort("email_verification email", () => this.sendEmailVerification(user.id, user.email!));
    } else {
      await this.sendWelcome(user.id);
    }

    return user;
  }

  /**
   * POST /api/auth/login (and the portal login). Every refusal is the same
   * generic 401 - a caller can't tell a wrong password from an unknown,
   * inactive or locked account. `onFailure` gets the real reason, for the
   * audit log. Consecutive wrong passwords lock the account
   * (auth.lockout_max_attempts / auth.lockout_duration_minutes); while
   * locked the password isn't even checked. With
   * auth.email_verification_required on, an account whose email isn't
   * verified is refused after the password matched - with its own
   * EMAIL_NOT_VERIFIED (403), so the sign-in page can offer to resend the
   * link; only someone holding the password learns it.
   */
  async login(
    input: {
      email: string;
      password: string;
      ip?: string | undefined;
      userAgent?: string | undefined;
    },
    onFailure?: (reason: LoginFailureReason, details?: { lockedNow?: boolean; userId?: string }) => void,
  ): Promise<LoginResult> {
    const refuse = (reason: LoginFailureReason, details?: { lockedNow?: boolean; userId?: string }): never => {
      onFailure?.(reason, details);
      throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid email or password.", { httpStatus: 401 });
    };

    const user = await this.users.findByEmailWithPasswordHash(input.email);
    if (!user) refuse("unknown_email");
    const found = user!;
    if (found.locked) refuse("locked", { userId: found.id });
    if (!found.active) refuse("inactive", { userId: found.id });
    if (!found.canLogin) refuse("cannot_login", { userId: found.id });
    if (!found.passwordHash) refuse("no_password", { userId: found.id });

    const valid = await verifyPassword(found.passwordHash!, input.password);
    if (!valid) {
      const [maxAttempts, lockMinutes] = await Promise.all([
        this.settings.get("auth.lockout_max_attempts"),
        this.settings.get("auth.lockout_duration_minutes"),
      ]);
      const { locked } = await this.users.recordFailedLogin(found.id, maxAttempts, lockMinutes);
      refuse("wrong_password", { lockedNow: locked, userId: found.id });
    }
    await this.assertEmailVerified(found, (reason, details) => onFailure?.(reason, details));
    const ttlHours = await this.settings.get("auth.session_ttl_hours");
    const maxSessions = await this.settings.get("auth.max_sessions_per_user");

    const { token, session: _session } = await this.sessions.create({
      user: found.id,
      ip: input.ip,
      userAgent: input.userAgent,
      ttlHours,
      maxSessionsPerUser: maxSessions,
    });

    await this.users.touchLastLogin(found.id);

    const { passwordHash: _omit, locked: _locked, ...publicUser } = found;
    return { token, user: publicUser };
  }

  /**
   * The verification gate every sign-in method passes (password, portal,
   * OAuth): with auth.email_verification_required on, an account whose
   * email isn't verified can't sign in (Specification_Security.md §2.7).
   */
  async assertEmailVerified(
    user: Pick<User, "id" | "emailVerifiedAt">,
    onFailure?: (reason: LoginFailureReason, details?: { userId?: string }) => void,
  ): Promise<void> {
    if (user.emailVerifiedAt) return;
    if (!(await this.settings.get("auth.email_verification_required"))) return;
    onFailure?.("email_not_verified", { userId: user.id });
    throw new TotalBaseError("EMAIL_NOT_VERIFIED", "Verify your email address before signing in - check your inbox, or ask for a new link.");
  }

  /** POST /api/auth/logout. */
  async logout(token: string): Promise<void> {
    await this.sessions.revokeByToken(token);
  }

  /** GET /api/auth/me. */
  async me(token: string): Promise<User> {
    const result = await this.sessions.validate(token);
    if (!result) {
      throw new TotalBaseError("SESSION_EXPIRED", "Session is invalid, expired, or revoked.");
    }
    return result.user;
  }

  /**
   * POST /api/auth/password/forgot. Always resolves without leaking
   * whether the email exists - a delivery failure included, since an
   * error only for known addresses would leak the same thing.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.email || !user.active || !user.canLogin) return;
    this.sendBestEffort("password_reset email", async () => {
      await this.sendPasswordReset({ id: user.id, email: user.email!, name: user.name }, "email");
    });
  }

  /**
   * Issues a password reset link for a known user - the admin's "Send
   * password reset". Unlike the public route, a delivery failure is
   * reported. With `delivery: "link"` nothing is emailed; the link is
   * returned for the admin to share.
   */
  async sendPasswordReset(user: { id: string } & SystemEmailRecipient, delivery: LinkDelivery): Promise<string> {
    const ttlMinutes = await this.settings.get("auth.password_reset_ttl_minutes");
    const token = await this.authTokens.create(user.id, "PASSWORD_RESET", ttlMinutes / 60);
    const url = await this.mailer.buildLink("password_reset", token);
    if (delivery === "email") {
      await this.mailer.send("password_reset", user, { url, expiresInHours: ttlMinutes / 60 });
    }
    return url;
  }

  /** POST /api/auth/password/reset. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const minLength = await this.settings.get("auth.password_min_length");
    assertPasswordStrength(newPassword, minLength);

    const userId = await this.authTokens.consume(token, "PASSWORD_RESET");
    const passwordHash = await hashPassword(newPassword);
    await this.users.setPasswordHash(userId, passwordHash);
    // Proving control of the email ends a lockout too - and verifies it:
    // the link only reached the person through that address.
    await this.users.unlock(userId);
    await this.users.markEmailVerified(userId);
    // Invalidate existing sessions on password change (security best practice).
    await this.sessions.revokeAllForUser(userId);
    await this.notifyPasswordChanged(userId);
  }

  /**
   * An admin sets a user's password (PUT /admin/api/users/:id/password) -
   * the same aftermath as a reset: strength-checked, lockout ended,
   * pending invitation / reset links retired (either could overwrite this
   * password), optionally every session signed out, and the "password
   * changed" notice sent. For the admin's own account `currentPassword`
   * is required (a stolen session can't change it) and `keepSessionId`
   * keeps them signed in.
   */
  async adminSetPassword(input: {
    userId: string;
    password: string;
    signOut: boolean;
    currentPassword?: string | undefined;
    keepSessionId?: string | undefined;
  }): Promise<void> {
    const user = await this.users.findByIdWithPasswordHash(input.userId);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    if (!user.canLogin) throw new TotalBaseError("PERMISSION_DENIED", "System accounts don't sign in with a password.");
    if (input.currentPassword !== undefined && user.passwordHash) {
      if (typeof input.currentPassword !== "string" || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
        throw new TotalBaseError("INVALID_CURRENT_PASSWORD", "The current password is incorrect.");
      }
    }
    await this.applyNewPassword(input);
    // An administrator giving a passwordless account (an invited shell) its
    // first password vouches for it, as creating a user with a password does.
    if (!user.passwordHash) await this.users.markEmailVerified(input.userId);
  }

  /**
   * A user changes their own password from My account (PUT
   * /app/api/me/password): the current password is always required - an
   * account without one (OAuth only) sets it through "Forgot password"
   * instead, so a stolen session can't add a lasting credential - and the
   * aftermath is the admin change's: lockout ended, links retired, the
   * other sessions signed out unless `signOutOthers: false` (the caller's
   * own is kept), the notice sent.
   */
  async changeOwnPassword(input: {
    userId: string;
    currentPassword: unknown;
    password: unknown;
    signOutOthers: boolean;
    keepSessionId: string;
  }): Promise<void> {
    const user = await this.users.findByIdWithPasswordHash(input.userId);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    if (!user.canLogin) throw new TotalBaseError("PERMISSION_DENIED", "System accounts don't sign in with a password.");
    if (!user.passwordHash) {
      throw new TotalBaseError("PERMISSION_DENIED", "This account has no password yet - use \"Forgot password\" on the sign-in page to set one.");
    }
    if (typeof input.currentPassword !== "string" || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new TotalBaseError("INVALID_CURRENT_PASSWORD", "The current password is incorrect.");
    }
    await this.applyNewPassword({
      userId: input.userId,
      password: input.password,
      signOut: input.signOutOthers,
      keepSessionId: input.keepSessionId,
    });
  }

  /** Confirms the current password of an account that has one - My account's email change asks for it. */
  async assertCurrentPassword(userId: string, currentPassword: unknown): Promise<void> {
    const user = await this.users.findByIdWithPasswordHash(userId);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    if (!user.passwordHash) {
      throw new TotalBaseError("PERMISSION_DENIED", "This account has no password yet - use \"Forgot password\" on the sign-in page to set one first.");
    }
    if (typeof currentPassword !== "string" || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new TotalBaseError("INVALID_CURRENT_PASSWORD", "The current password is incorrect.");
    }
  }

  private async applyNewPassword(input: { userId: string; password: unknown; signOut: boolean; keepSessionId?: string | undefined }): Promise<void> {
    if (typeof input.password !== "string") throw new TotalBaseError("INVALID_QUERY", "password is required.");
    assertPasswordStrength(input.password, await this.settings.get("auth.password_min_length"));

    await this.users.setPasswordHash(input.userId, await hashPassword(input.password));
    await this.users.unlock(input.userId);
    await this.authTokens.retire(input.userId, ["INVITATION", "PASSWORD_RESET"]);
    if (input.signOut) await this.sessions.revokeAllForUser(input.userId, input.keepSessionId);
    await this.notifyPasswordChanged(input.userId);
  }

  /** POST /api/auth/password/change. Requires an authenticated user. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findByIdWithPasswordHash(userId);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    // Same answers as My account's change (changeOwnPassword): the session
    // is fine, only the confirmation failed - a 400, never a 401.
    if (!user.passwordHash) {
      throw new TotalBaseError("PERMISSION_DENIED", "This account has no password yet - use \"Forgot password\" on the sign-in page to set one.");
    }
    if (typeof currentPassword !== "string" || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new TotalBaseError("INVALID_CURRENT_PASSWORD", "The current password is incorrect.");
    }

    const minLength = await this.settings.get("auth.password_min_length");
    assertPasswordStrength(newPassword, minLength);

    const passwordHash = await hashPassword(newPassword);
    await this.users.setPasswordHash(userId, passwordHash);
    await this.notifyPasswordChanged(userId);
  }

  /** POST /api/auth/email/resend, and internally after registration. */
  async sendEmailVerification(userId: string, email: string): Promise<void> {
    const ttlHours = await this.settings.get("auth.email_verification_ttl_hours");
    const token = await this.authTokens.create(userId, "EMAIL_VERIFICATION", ttlHours);
    const user = await this.users.findById(userId);
    const url = await this.mailer.buildLink("email_verification", token);
    await this.mailer.send("email_verification", { email, name: user?.name ?? null }, { url, expiresInHours: ttlHours });
  }

  /** POST /api/auth/email/resend with a session: a new link for the signed-in account, unless it is already verified. */
  async resendEmailVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.email || user.emailVerifiedAt) return;
    await this.sendEmailVerification(user.id, user.email);
  }

  /**
   * POST /api/auth/email/resend without a session (a sign-in refused with
   * EMAIL_NOT_VERIFIED). Like requestPasswordReset it always resolves - a
   * delivery failure included - so it never tells whether an account
   * exists; a link goes only to an active, unverified account that can
   * sign in.
   */
  async resendEmailVerificationByEmail(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user?.email || user.emailVerifiedAt || !user.active || !user.canLogin) return;
    this.sendBestEffort("email_verification email", () => this.sendEmailVerification(user.id, user.email!));
  }

  /** POST /api/auth/email/verify. */
  async verifyEmail(token: string): Promise<void> {
    const userId = await this.authTokens.consume(token, "EMAIL_VERIFICATION");
    await this.users.markEmailVerified(userId);
  }

  /**
   * Admin-initiated invitation: the user shell already exists (no
   * password); this issues the single-use link, retiring any earlier one.
   * With `delivery: "link"` nothing is emailed - the link is returned for
   * the admin to share another way (e.g. while SMTP isn't set up yet).
   */
  async createInvitation(user: { id: string } & SystemEmailRecipient, delivery: LinkDelivery = "email"): Promise<string> {
    const ttlHours = await this.settings.get("auth.invitation_ttl_hours");
    const token = await this.authTokens.create(user.id, "INVITATION", ttlHours);
    const url = await this.mailer.buildLink("invitation", token);
    if (delivery === "email") {
      await this.mailer.send("user_invitation", user, { url, expiresInHours: ttlHours });
    }
    return url;
  }

  /** POST /api/auth/invitations/accept (public). */
  async acceptInvitation(token: string, password: string): Promise<LoginResult> {
    const minLength = await this.settings.get("auth.password_min_length");
    assertPasswordStrength(password, minLength);

    const userId = await this.authTokens.consume(token, "INVITATION");
    const passwordHash = await hashPassword(password);
    await this.users.setPasswordHash(userId, passwordHash);
    await this.users.markEmailVerified(userId);

    const ttlHours = await this.settings.get("auth.session_ttl_hours");
    const maxSessions = await this.settings.get("auth.max_sessions_per_user");
    const { token: sessionToken } = await this.sessions.create({
      user: userId,
      ttlHours,
      maxSessionsPerUser: maxSessions,
    });

    const user = await this.users.findById(userId);
    await this.sendWelcome(userId);
    return { token: sessionToken, user: user! };
  }
}
