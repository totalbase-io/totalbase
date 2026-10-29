import { createHash } from "node:crypto";
import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { readImageDimensions } from "./image-transform.js";
import { FilesStorage } from "./files-storage.js";
import { FilesLocalStorageProvider } from "./local-storage-provider.js";
import { detectMimeType } from "./mime-detection.js";

export interface FileRecord {
  id: string;
  folder: string | null;
  name: string;
  extension: string;
  mime_type: string;
  size_bytes: number;
  storage_provider: string;
  storage_key: string;
  checksum: string | null;
  width: number | null;
  height: number | null;
  visibility: "PRIVATE" | "PUBLIC";
  metadata: Record<string, unknown>;
  description: string | null;
  tags: string[];
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FileRow extends Omit<FileRecord, "size_bytes"> {
  size_bytes: string;
}

export interface UploadFileInput {
  folder?: string | null | undefined;
  content: Buffer;
  filename: string;
  declaredContentType?: string | undefined;
  visibility?: "PRIVATE" | "PUBLIC" | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  /**
   * The user behind the upload (a session's user, a token's owner, a
   * workflow's executor). PostgreSQL records it as `created_by`/`updated_by`
   * (triggers reading `totalbase.actor_user_id`, like folders); omitted, the
   * caller's transaction actor applies, else none (the system).
   */
  actorUserId?: string | undefined;
}

export interface UpdateFileMetadataInput {
  visibility?: "PRIVATE" | "PUBLIC" | undefined;
  description?: string | null | undefined;
  tags?: string[] | undefined;
  /** Rename: trimmed like an upload's filename; `extension` follows it. PostgreSQL's CHECKs decide the rest (1-255 characters). */
  name?: string | undefined;
  /** Move: a folder id, or null for the root. The folder must exist - the foreign key decides. */
  folder?: string | null | undefined;
}

function toRecord(row: FileRow): FileRecord {
  return {
    ...row,
    size_bytes: Number(row.size_bytes),
  };
}

function extensionFromName(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}

export class FilesAdminService {
  constructor(
    private readonly database: Queryable,
    private readonly settings: SettingsService,
    private readonly storage: FilesStorage = new FilesStorage(settings),
    /** Called, never awaited, once a file's content is stored and its row written - the server warms its thumbnail. */
    private readonly afterStore?: (file: FileRecord, content: Buffer) => void,
  ) {}

  async list(folder?: string | null): Promise<FileRecord[]> {
    const params: unknown[] = [];
    let where = "";
    if (folder !== undefined) {
      params.push(folder);
      where = folder === null ? "WHERE folder IS NULL" : "WHERE folder = $1";
    }
    const { rows } = await this.database.query<FileRow>(
      `SELECT * FROM totalbase.files ${where} ORDER BY name`,
      params,
    );
    return rows.map(toRecord);
  }

  async get(id: string): Promise<FileRecord> {
    const { rows } = await this.database.query<FileRow>(
      `SELECT * FROM totalbase.files WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new TotalBaseError("RESOURCE_NOT_FOUND", "File not found.");
    return toRecord(rows[0]);
  }

  async upload(input: UploadFileInput): Promise<FileRecord> {
    const [enabled, maxSizeBytes, allowedMimeTypes, defaultVisibilityPublic] = await Promise.all([
      this.settings.get("files.enabled"),
      this.settings.get("files.max_file_size_bytes"),
      this.settings.get("files.allowed_mime_types"),
      this.settings.get("files.default_visibility_public"),
    ]);
    if (!enabled) {
      throw new TotalBaseError("FILE_ACCESS_DENIED", "The Files feature is disabled.");
    }
    if (input.content.length === 0) {
      throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "An uploaded file is required.");
    }
    if (input.content.length > maxSizeBytes) {
      throw new TotalBaseError("FILE_TOO_LARGE", `Uploaded file exceeds the configured maximum of ${maxSizeBytes} bytes.`);
    }
    if (input.folder) {
      const { rowCount } = await this.database.query(
        `SELECT 1 FROM totalbase.folders WHERE id = $1`,
        [input.folder],
      );
      if (rowCount === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Folder not found.");
    }

    const name = input.filename.trim();
    if (!name) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A filename is required.");

    const storageKey = FilesLocalStorageProvider.generateKey();
    const checksum = createHash("sha256").update(input.content).digest("hex");
    // Never trust only the client-provided Content-Type: prefer the
    // detected magic-byte signature, falling back to the declared type
    // only when the signature isn't one mime-detection.ts recognizes.
    const detected = detectMimeType(input.content);
    const mimeType = detected ?? input.declaredContentType ?? "application/octet-stream";
    if (!matchesAllowedMimeType(mimeType, allowedMimeTypes)) {
      throw new TotalBaseError("FILE_MIME_TYPE_NOT_ALLOWED", `MIME type not allowed: ${mimeType}`);
    }

    // Best-effort - a corrupt-but-otherwise-valid-signature image
    // shouldn't fail the whole upload over metadata.
    let width: number | null = null;
    let height: number | null = null;
    if (mimeType.startsWith("image/")) {
      try {
        const dimensions = await readImageDimensions(input.content);
        width = dimensions.width;
        height = dimensions.height;
      } catch {
        // leave null - not fatal for the upload itself
      }
    }

    const storage = await this.storage.current();
    await storage.store(storageKey, input.content);

    try {
      // created_by/updated_by are PostgreSQL's (files_set_created_by,
      // files_set_updated_by): the actor is set for this statement's
      // transaction by the row source itself, so it applies whether or not
      // the caller runs inside a transaction of its own.
      const { rows } = await this.database.query<FileRow>(
        `INSERT INTO totalbase.files
           (folder, name, extension, mime_type, size_bytes, storage_provider, storage_key, checksum, width, height, visibility, metadata, description, tags)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, $12, $13
         FROM (SELECT set_config('totalbase.actor_user_id', COALESCE($14::text, current_setting('totalbase.actor_user_id', true), ''), true) AS actor) AS context
         WHERE context.actor IS NOT NULL
         RETURNING *`,
        [
          input.folder ?? null,
          name,
          extensionFromName(name),
          mimeType,
          input.content.length,
          storage.name,
          storageKey,
          checksum,
          width,
          height,
          input.visibility ?? (defaultVisibilityPublic ? "PUBLIC" : "PRIVATE"),
          input.description?.trim() || null,
          cleanTags(input.tags),
          input.actorUserId ?? null,
        ],
      );
      const record = toRecord(rows[0]!);
      this.afterStore?.(record, input.content);
      return record;
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async readContent(id: string): Promise<{ file: FileRecord; content: Buffer }> {
    const file = await this.get(id);
    const storage = await this.storage.of(file.storage_provider);
    const content = await storage.read(file.storage_key);
    return { file, content };
  }

  /** `updated_by` is set by PostgreSQL from the caller's transaction actor (`totalbase.actor_user_id`). */
  async updateContent(id: string, content: Buffer): Promise<FileRecord> {
    const file = await this.get(id);
    const storage = await this.storage.of(file.storage_provider);
    const checksum = createHash("sha256").update(content).digest("hex");

    let width: number | null = null;
    let height: number | null = null;
    if (file.mime_type.startsWith("image/")) {
      try {
        const dimensions = await readImageDimensions(content);
        width = dimensions.width;
        height = dimensions.height;
      } catch {
        // leave null - not fatal
      }
    }

    await storage.store(file.storage_key, content);
    await this.database.query(
      `UPDATE totalbase.files
       SET size_bytes = $2, checksum = $3, width = $4, height = $5, updated_at = now()
       WHERE id = $1`,
      [id, content.length, checksum, width, height],
    );
    const record = await this.get(id);
    this.afterStore?.(record, content);
    return record;
  }

  async updateMetadata(id: string, patch: UpdateFileMetadataInput): Promise<FileRecord> {
    await this.get(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.visibility !== undefined) push("visibility", patch.visibility);
    if (patch.description !== undefined) push("description", patch.description?.trim() || null);
    if (patch.tags !== undefined) push("tags", cleanTags(patch.tags));
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      push("name", name);
      push("extension", extensionFromName(name));
    }
    if (patch.folder !== undefined) push("folder", patch.folder);
    if (sets.length === 0) return this.get(id);
    params.push(id);
    try {
      await this.database.query(
        `UPDATE totalbase.files
         SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $${params.length}`,
        params,
      );
    } catch (error) {
      // The same foreign key refuses deleting a folder that still holds
      // files, so its message can't live in a constraint COMMENT: a move's
      // violation is named here.
      if (error instanceof TotalBaseError && error.code === "FOREIGN_KEY_VIOLATION" && error.constraint === "files_folder_fkey") {
        throw new TotalBaseError("FOREIGN_KEY_VIOLATION", "The target folder doesn't exist.", {
          source: "POSTGRESQL", sqlstate: error.sqlstate, constraint: error.constraint, field: "folder",
        });
      }
      throw error;
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const file = await this.get(id);
    await this.database.query(`DELETE FROM totalbase.files WHERE id = $1`, [id]);
    const storage = await this.storage.of(file.storage_provider);
    await storage.delete(file.storage_key);
  }
}

function matchesAllowedMimeType(mimeType: string, allowed: string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern === mimeType) return true;
    if (pattern.endsWith("/*")) return mimeType.startsWith(pattern.slice(0, -1));
    return false;
  });
}
