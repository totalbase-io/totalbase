import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

export type AuthProviderType = "GOOGLE" | "GITHUB" | "OIDC";

export interface AuthProviderConfig {
  client_id: string;
  /** References a key in totalbase.secrets - the plaintext secret is never stored here or returned by any admin route (same pattern as Integrations' header secrets and mailings.smtp_password_secret_key). */
  client_secret_key: string;
  scopes?: string[];
  /** See oauth-redirect.ts. Empty means no login can ever complete for this provider - not a footgun default, a deliberate fail-closed one. */
  allowed_redirect_urls: string[];
  /** Assigned to a *newly created* user on their first successful login through this provider; never touches an existing user's roles. Null = same as LOCAL self-registration - no role until an admin grants one. */
  default_role_id?: string | null;
  /** OIDC only - the issuer used to fetch {issuer}/.well-known/openid-configuration. */
  issuer?: string;
}

export interface AuthProvider {
  id: string;
  type: AuthProviderType;
  name: string;
  /** Its route segment, /api/auth/oauth/{slug}: google, github, or an OIDC provider's name slugified - stored, UNIQUE. */
  slug: string;
  enabled: boolean;
  /** Its button on the portal's sign-in page - the portal flow is refused while off. */
  showOnSignIn: boolean;
  configuration: AuthProviderConfig;
  createdAt: Date;
  updatedAt: Date;
}

interface AuthProviderRow {
  id: string;
  type: AuthProviderType;
  slug: string;
  name: string;
  enabled: boolean;
  show_on_sign_in: boolean;
  configuration: AuthProviderConfig;
  created_at: Date;
  updated_at: Date;
}

function toAuthProvider(row: AuthProviderRow): AuthProvider {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    slug: row.slug,
    enabled: row.enabled,
    showOnSignIn: row.show_on_sign_in,
    configuration: row.configuration,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Lowercased, non-alphanumeric runs collapsed to a single "-" (slugify's rule) - an OIDC provider's slug, from its name, stored at creation. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SELECT_COLUMNS = `id, type, name, slug, enabled, show_on_sign_in, configuration, created_at, updated_at`;

/**
 * Persistence + slug resolution for totalbase.providers. The route
 * segment in GET /api/auth/oauth/:provider is the stored, UNIQUE `slug`:
 * "google"/"github" (one provider of each, a partial unique index on
 * `type`), or an OIDC provider's name slugified at creation
 * (Security.md §2.5: "my-company" for "My Company"). The
 * database decides uniqueness - a duplicate is AUTH_PROVIDER_NAME_DUPLICATE
 * from the constraint, never a check-then-insert.
 */
export class AuthProvidersService {
  constructor(private readonly database: Database) {}

  async list(): Promise<AuthProvider[]> {
    const { rows } = await this.database.query<AuthProviderRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.providers ORDER BY created_at`,
    );
    return rows.map(toAuthProvider);
  }

  async get(id: string): Promise<AuthProvider> {
    const { rows } = await this.database.query<AuthProviderRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.providers WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", `Auth provider not found: ${id}`);
    return toAuthProvider(row);
  }

  slugFor(provider: Pick<AuthProvider, "slug">): string {
    return provider.slug;
  }

  /** Resolves the :provider route segment - throws AUTH_PROVIDER_NOT_FOUND rather than returning null, since every caller needs the provider to proceed. */
  async findBySlugOrThrow(slug: string): Promise<AuthProvider> {
    const { rows } = await this.database.query<AuthProviderRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.providers WHERE slug = $1`,
      [slug.toLowerCase()],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", `Auth provider not found: ${slug}`);
    return toAuthProvider(row);
  }

  /** A UNIQUE violation as its own error: one provider per type, one slug. */
  private remapUnique(error: unknown, type: AuthProviderType, slug: string): never {
    if (error instanceof TotalBaseError && error.code === "UNIQUE_VIOLATION") {
      throw new TotalBaseError(
        "AUTH_PROVIDER_NAME_DUPLICATE",
        error.constraint === "providers_one_per_type_idx"
          ? `Only one ${type} provider can be configured - the route segment ("${type.toLowerCase()}") has nowhere else to point.`
          : `A provider already answers at "${slug}" - another OIDC provider's name slugifies the same.`,
        { cause: error },
      );
    }
    throw error;
  }

  async create(input: { type: AuthProviderType; name: string; enabled?: boolean | undefined; showOnSignIn?: boolean | undefined; configuration: AuthProviderConfig }): Promise<AuthProvider> {
    const slug = input.type === "OIDC" ? slugify(input.name) : input.type.toLowerCase();
    if (!slug) throw new TotalBaseError("INVALID_NAME", "An OIDC provider's name needs a letter or a digit - its route segment comes from it.");
    try {
      const { rows } = await this.database.query<AuthProviderRow>(
        `INSERT INTO totalbase.providers (type, name, slug, enabled, show_on_sign_in, configuration)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING ${SELECT_COLUMNS}`,
        [input.type, input.name, slug, input.enabled ?? true, input.showOnSignIn ?? false, JSON.stringify(input.configuration)],
      );
      return toAuthProvider(rows[0]!);
    } catch (error) {
      this.remapUnique(error, input.type, slug);
    }
  }

  async update(
    id: string,
    patch: { name?: string | undefined; enabled?: boolean | undefined; showOnSignIn?: boolean | undefined; configuration?: AuthProviderConfig | undefined },
  ): Promise<AuthProvider> {
    const current = await this.get(id);
    // A renamed OIDC provider moves to its new name's slug - a published sign-in link that names the old one stops working, as a rename of any addressed thing does.
    const slug = current.type === "OIDC" && patch.name !== undefined ? slugify(patch.name) : current.slug;
    if (!slug) throw new TotalBaseError("INVALID_NAME", "An OIDC provider's name needs a letter or a digit - its route segment comes from it.");
    try {
      const { rows } = await this.database.query<AuthProviderRow>(
        `UPDATE totalbase.providers
         SET name = COALESCE($2, name),
             slug = $5,
             enabled = COALESCE($3, enabled),
             show_on_sign_in = COALESCE($6, show_on_sign_in),
             configuration = COALESCE($4::jsonb, configuration),
             updated_at = now()
         WHERE id = $1
         RETURNING ${SELECT_COLUMNS}`,
        [id, patch.name ?? null, patch.enabled ?? null, patch.configuration ? JSON.stringify(patch.configuration) : null, slug, patch.showOnSignIn ?? null],
      );
      const row = rows[0];
      if (!row) throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", `Auth provider not found: ${id}`);
      return toAuthProvider(row);
    } catch (error) {
      this.remapUnique(error, current.type, slug);
    }
  }

  async delete(id: string): Promise<void> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.providers WHERE id = $1`, [id]);
    if (rowCount === 0) throw new TotalBaseError("AUTH_PROVIDER_NOT_FOUND", `Auth provider not found: ${id}`);
  }
}
