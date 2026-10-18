import type { Queryable } from "@totalbase/database";
import { remapUniqueViolation, TotalBaseError } from "@totalbase/errors";
import { slugify, validateDescription, validateName, validateSlug } from "@totalbase/shared";
import type { TemplateKind } from "./templates-service.js";

export interface TemplateAdminRecord {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: TemplateKind;
  content: unknown;
  defaultCc: string[] | null;
  defaultBcc: string[] | null;
  defaultReplyTo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateAdminRow {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  kind: TemplateKind;
  content: unknown;
  default_cc: string[] | null;
  default_bcc: string[] | null;
  default_reply_to: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: TemplateAdminRow): TemplateAdminRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    slug: row.slug,
    kind: row.kind,
    content: row.content,
    defaultCc: row.default_cc,
    defaultBcc: row.default_bcc,
    defaultReplyTo: row.default_reply_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTemplateInput {
  name: string;
  description?: string | null | undefined;
  slug?: string | undefined;
  kind: TemplateKind;
  content: unknown;
  defaultCc?: string[];
  defaultBcc?: string[];
  defaultReplyTo?: string;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string | null;
  slug?: string;
  content?: unknown;
  defaultCc?: string[] | null;
  defaultBcc?: string[] | null;
  defaultReplyTo?: string | null;
}

function mapUniqueViolation(error: unknown): never {
  return remapUniqueViolation(
    error,
    [{ constraint: "templates_slug_unique", code: "TEMPLATE_SLUG_DUPLICATE", message: "A template with this slug already exists." }],
    { code: "TEMPLATE_NAME_DUPLICATE", message: "A template with this name already exists." },
  );
}

/**
 * Generic, kind-agnostic CRUD for totalbase.templates - the Admin
 * UI's single "Templates" screen, which manages every kind in one place. `content`'s shape is enforced by the DB CHECK
 * (templates_mailing_content_shape/templates_content_is_object) - a
 * violation surfaces as the generic CHECK_VIOLATION (422), not a bespoke
 * error here.
 */
export class TemplatesAdminService {
  constructor(private readonly database: Queryable) {}

  async create(input: CreateTemplateInput): Promise<TemplateAdminRecord> {
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const slug = validateSlug(input.slug?.trim() ? input.slug : slugify(name));

    try {
      const { rows } = await this.database.query<TemplateAdminRow>(
        `INSERT INTO totalbase.templates (name, description, slug, kind, content, default_cc, default_bcc, default_reply_to)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING *`,
        [
          name,
          description,
          slug,
          input.kind,
          JSON.stringify(input.content),
          input.defaultCc ?? null,
          input.defaultBcc ?? null,
          input.defaultReplyTo ?? null,
        ],
      );
      return toRecord(rows[0]!);
    } catch (error) {
      mapUniqueViolation(error);
    }
  }

  async get(id: string): Promise<TemplateAdminRecord> {
    const { rows } = await this.database.query<TemplateAdminRow>(`SELECT * FROM totalbase.templates WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new TotalBaseError("TEMPLATE_NOT_FOUND", `Template not found: ${id}`);
    return toRecord(row);
  }

  async list(kind?: TemplateKind): Promise<TemplateAdminRecord[]> {
    const { rows } = kind
      ? await this.database.query<TemplateAdminRow>(
          `SELECT * FROM totalbase.templates WHERE kind = $1 ORDER BY created_at DESC`,
          [kind],
        )
      : await this.database.query<TemplateAdminRow>(`SELECT * FROM totalbase.templates ORDER BY created_at DESC`);
    return rows.map(toRecord);
  }

  async update(id: string, patch: UpdateTemplateInput): Promise<TemplateAdminRecord> {
    await this.get(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.name !== undefined) push("name", validateName(patch.name));
    if (patch.description !== undefined) push("description", validateDescription(patch.description));
    if (patch.slug !== undefined) push("slug", validateSlug(patch.slug));
    if (patch.content !== undefined) push("content", JSON.stringify(patch.content));
    if (patch.defaultCc !== undefined) push("default_cc", patch.defaultCc);
    if (patch.defaultBcc !== undefined) push("default_bcc", patch.defaultBcc);
    if (patch.defaultReplyTo !== undefined) push("default_reply_to", patch.defaultReplyTo);
    if (sets.length === 0) return this.get(id);
    params.push(id);
    try {
      await this.database.query(`UPDATE totalbase.templates SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    } catch (error) {
      mapUniqueViolation(error);
    }
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.database.query(`DELETE FROM totalbase.templates WHERE id = $1`, [id]);
  }
}
