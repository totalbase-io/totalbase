import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart, { type MultipartFile } from "@fastify/multipart";
import { TotalBaseError } from "@totalbase/errors";
import { FilesAdminService, type FileRecord } from "@totalbase/files";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import {
  assertColumnsGranted,
  assertFileActionAllowed,
  createFileAuthorized,
  assertFileReadAllowed,
  assertVisibilityAllowed,
  resolveTableGrant,
  rowFilterLimits,
  rowPassesGrant,
} from "@totalbase/mutations";
import type { DataPrincipal } from "../data-principal.js";
import { dataEnvelope, type ParameterObject } from "@totalbase/openapi";
import { canOnTotalbaseResource, FILE_REF, FILE_SCHEMAS } from "../openapi-docs.js";
import { optionalData } from "../request-body.js";
import { sendFileContent, sendFileRendition } from "../file-response.js";
import { resolveTableResource } from "@totalbase/resources";
import { ReadAudit, readOrigin } from "../read-audit.js";

/**
 * Where and how a file is stored is TotalBase's own business: the Data API
 * never returns it (the Admin API's Files screen still shows it). The same
 * columns are in totalbase-guardrails.ts's PROTECTED_FIELDS, for the
 * generic table routes.
 */
function publicFile(record: FileRecord): Omit<FileRecord, "storage_provider" | "storage_key"> {
  const { storage_provider: _provider, storage_key: _key, ...rest } = record;
  return rest;
}

/**
 * An UPDATE on one file, authorized like a Data API write: the action
 * grant, the written columns' field grants, and the grant's row filter on
 * the file before AND after the change (AGENTS.md section 13), in one
 * transaction - a change that would take the file out of the caller's own
 * scope is refused and rolled back.
 */
async function updateFileAuthorized(
  context: AppContext,
  dataPrincipal: DataPrincipal,
  fileId: string,
  columns: readonly string[],
  change: (files: FilesAdminService) => Promise<FileRecord>,
  visibility?: string,
): Promise<FileRecord> {
  const grant = await resolveTableGrant(context, dataPrincipal, "files", "UPDATE", "FILE_ACCESS_DENIED");
  assertColumnsGranted(grant, [...columns], "FILE_ACCESS_DENIED");
  const limits = await rowFilterLimits(context);
  return context.database.transaction(async (client) => {
    if (!(await rowPassesGrant(client, context, dataPrincipal, grant, fileId, limits))) {
      throw new TotalBaseError("FILE_ACCESS_DENIED", "UPDATE is not authorized for Files.");
    }
    // A new visibility is the uploader's, or an administrator's, to set (Administration.md §10.6).
    if (visibility !== undefined) {
      const { rows } = await client.query<{ created_by: string | null; visibility: string }>(
        `SELECT created_by, visibility FROM totalbase.files WHERE id = $1`, [fileId]);
      if (rows[0] && rows[0].visibility !== visibility) await assertVisibilityAllowed(context, dataPrincipal, visibility, rows[0].created_by);
    }
    const record = await change(new FilesAdminService(client, context.settings, context.filesStorage));
    if (!(await rowPassesGrant(client, context, dataPrincipal, grant, fileId, limits))) {
      throw new TotalBaseError("FILE_ACCESS_DENIED", "The file would no longer satisfy your permission's row filter.");
    }
    return record;
  }, { actorUserId: dataPrincipal.actorUserId });
}

/** An upload's `visibility` field (Administration.md §10.4): one of the three, or none for `files.default_visibility_public`. */
function uploadVisibility(value: string | undefined): "PRIVATE" | "LINKED" | "PUBLIC" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "PRIVATE" || value === "LINKED" || value === "PUBLIC") return value;
  throw new TotalBaseError("INVALID_QUERY", "visibility must be PRIVATE, LINKED or PUBLIC.");
}

/** Shared by every Files route's `config.openapi`. */
const FILES_DOC = { tags: ["files"], access: "principal" as const, schemas: FILE_SCHEMAS, errors: ["413" as const] };

/** packages/files transform-params.ts - image files only; a preset expands to a saved combination of these. */
const TRANSFORM_PARAMETERS: ParameterObject[] = [
  { name: "preset", in: "query", schema: { type: "string" }, description: "A named preset (Settings > Files)." },
  { name: "width", in: "query", schema: { type: "integer", minimum: 1 } },
  { name: "height", in: "query", schema: { type: "integer", minimum: 1 } },
  { name: "fit", in: "query", schema: { type: "string", enum: ["cover", "contain", "inside"] } },
  { name: "format", in: "query", schema: { type: "string", enum: ["jpeg", "png", "webp", "avif"] } },
  { name: "quality", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
  { name: "rotate", in: "query", schema: { type: "integer", enum: [0, 90, 180, 270] } },
  { name: "flip", in: "query", schema: { type: "string", enum: ["horizontal", "vertical"] } },
  { name: "cropLeft", in: "query", schema: { type: "integer", minimum: 0 } },
  { name: "cropTop", in: "query", schema: { type: "integer", minimum: 0 } },
  { name: "cropWidth", in: "query", schema: { type: "integer", minimum: 1 } },
  { name: "cropHeight", in: "query", schema: { type: "integer", minimum: 1 } },
  { name: "grayscale", in: "query", schema: { type: "boolean" } },
  { name: "blur", in: "query", schema: { type: "number", minimum: 0.3, maximum: 100 } },
  { name: "sharpen", in: "query", schema: { type: "boolean" } },
];


interface UpdateFileBody {
  visibility?: "PRIVATE" | "LINKED" | "PUBLIC";
  description?: string | null;
  tags?: string[];
  name?: string;
  folder?: string | null;
}


/** Multipart fields are always strings - `tags` travels as a comma-separated list (empty/blank entries dropped), unlike PATCH's JSON body where it's a real string[]. */
function parseTagsField(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Public Files API, the same convention as routes/assets.ts: GET on the
 * bare `:id` renders the file itself (binary content, with the same
 * transformation query params as the admin content route), metadata-as-
 * JSON lives on `:id/info`. CREATE is gated by a plain action check (no
 * row exists yet to scope a filter against); READ/UPDATE/DELETE go
 * through @totalbase/mutations' files-authorization.ts row-filter-aware check instead, both
 * resolved through the exact same totalbase.permissions +
 * EffectivePermissionService engine as any other resource - see
 * that file's comment for why totalbase.files
 * doesn't need a bespoke permission model.
 */

/**
 * The upload's `file` part, read up to `files.max_file_size_bytes` and no further (Administration.md §10.4): past it
 * the transfer is dropped as it arrives and the request answers FILE_TOO_LARGE - never a whole oversized body held in
 * memory before anything checks it. A replaced content (`PUT .../content`) is held to the same limit.
 */
async function readUploadedFile(context: AppContext, request: FastifyRequest): Promise<{ file: MultipartFile; content: Buffer }> {
  const maxBytes = await context.settings.get("files.max_file_size_bytes");
  const file = await request.file({ limits: { fileSize: maxBytes } });
  if (!file) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A multipart 'file' field is required.");
  try {
    return { file, content: await file.toBuffer() };
  } catch (error) {
    if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new TotalBaseError("FILE_TOO_LARGE", `Uploaded file exceeds the configured maximum of ${maxBytes} bytes.`);
    }
    throw error;
  }
}

export function registerFilesRoutes(app: FastifyInstance, context: AppContext): void {
  app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } }); // service enforces the real limit

    scoped.post("/api/totalbase/table/files", {
      config: {
        openapi: {
          ...FILES_DOC,
          summary: "Upload a file",
          requestBody: {
            contentType: "multipart/form-data",
            schema: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", format: "binary" },
                folder: { type: "string", description: "Folder id." },
                visibility: { type: "string", enum: ["PRIVATE", "LINKED", "PUBLIC"], default: "PRIVATE" },
                description: { type: "string" },
                tags: { type: "string", description: "Comma-separated." },
              },
            },
          },
          response: { status: "201", schema: dataEnvelope(FILE_REF) },
          visible: canOnTotalbaseResource(context, "files", "CREATE"),
        },
      },
    }, async (request, reply) => {
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      await resolveTableGrant(context, dataPrincipal, "files", "CREATE", "FILE_ACCESS_DENIED");

      const { file, content } = await readUploadedFile(context, request);
      const fields = file.fields as Record<string, { value?: string } | undefined>;
      const folderValue = fields.folder?.value;
      // The columns the caller sets need their field grants, as on any other table (Security.md §6.4).
      const columns = ["visibility", "folder", "description", "tags"].filter((column) => (fields[column]?.value ?? "") !== "");
      // A visibility the uploader chooses is theirs to set - Public only while uploaders may publish (§10.6).
      const visibility = uploadVisibility(fields.visibility?.value);
      if (visibility !== undefined) await assertVisibilityAllowed(context, dataPrincipal, visibility, dataPrincipal.actorUserId ?? null);

      const record = await createFileAuthorized(context, dataPrincipal, columns, () => context.filesAdmin.upload({
        folder: folderValue ? folderValue : null,
        content,
        filename: file.filename,
        declaredContentType: file.mimetype,
        visibility,
        description: fields.description?.value,
        tags: parseTagsField(fields.tags?.value),
        actorUserId: dataPrincipal.actorUserId ?? undefined,
      }), (id) => context.filesAdmin.remove(id));
      reply.code(201);
      return { data: publicFile(record) };
    });

    // Content and info share the same authorization rule, except that a
    // public file bypasses it entirely. A read of any other file is audited
    // as a Data API read of files when its resource has audit_read on
    // (Security.md §11.5): who opened which file, its content or its details -
    // the EXECUTED row before anything is sent, so nothing leaves unrecorded.
    async function authorizeRead(request: FastifyRequest<{ Params: { id: string } }>, content: boolean) {
      const file = await context.filesAdmin.get(request.params.id);
      if (file.visibility === "PUBLIC") return file;
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      const readAudit = new ReadAudit(context, readOrigin(request), await resolveTableResource(context, "totalbase", "files", "GET"), dataPrincipal);
      const detail = { pk: file.id, content };
      try {
        await assertFileReadAllowed(context, dataPrincipal, file);
      } catch (error) {
        await readAudit.failed("DENIED", detail, error);
        throw error;
      }
      await readAudit.executed(context.database, detail, 1);
      return file;
    }

    scoped.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
      "/api/totalbase/table/files/:id",
      {
        config: {
          openapi: {
            ...FILES_DOC,
            summary: "Download a file's content",
            description: "PUBLIC files need no credentials. Image files accept on-the-fly transformation parameters.",
            pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
            parameters: TRANSFORM_PARAMETERS,
            response: { status: "200", contentType: "application/octet-stream", schema: { type: "string", format: "binary" }, description: "The file (or its transformed rendition), with its own content type." },
            visible: canOnTotalbaseResource(context, "files", "READ"),
          },
        },
      },
      async (request, reply) => {
        const file = await authorizeRead(request, true);
        // The URL stays the same when the content is replaced: the browser revalidates (no-cache) against the
        // checksum, a 304 while it's unchanged - a cached original or rendition never outlives its content.
        const etag = file.checksum ? `"${file.checksum}"` : undefined;
        if (etag) {
          reply.header("etag", etag);
          reply.header("cache-control", "private, no-cache");
          if (request.headers["if-none-match"]?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
            return reply.code(304).send();
          }
        }
        const transformed = file.checksum
          ? await context.filesTransform.resolve({
              fileId: file.id,
              sourceHash: file.checksum,
              mimeType: file.mime_type,
              query: request.query,
              readOriginal: async () => (await context.filesAdmin.readContent(file.id)).content,
            })
          : undefined;

        if (transformed) return sendFileRendition(reply, transformed.contentType, transformed.buffer);

        const { content } = await context.filesAdmin.readContent(file.id);
        return sendFileContent(reply, { mimeType: file.mime_type, name: file.name }, content);
      },
    );

    scoped.get<{ Params: { id: string } }>("/api/totalbase/table/files/:id/info", {
      config: {
        openapi: {
          ...FILES_DOC,
          summary: "A file's metadata",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          response: { status: "200", schema: dataEnvelope(FILE_REF) },
          visible: canOnTotalbaseResource(context, "files", "READ"),
        },
      },
    }, async (request) => ({
      data: publicFile(await authorizeRead(request, false)),
    }));

    scoped.patch<{ Params: { id: string }; Body: { data?: UpdateFileBody } | null }>("/api/totalbase/table/files/:id", {
      config: {
        openapi: {
          ...FILES_DOC,
          summary: "Update a file's metadata, rename or move it",
          description:
            "Writes only the fields sent. `name` renames (trimmed; 1-255 characters - PostgreSQL's CHECKs; `extension` follows it), " +
            "`folder` moves (a folder id, null = root; a folder that doesn't exist is 409 FOREIGN_KEY_VIOLATION). " +
            "Needs UPDATE with field grants on every written column, and the file within the grant's row filter before and after.",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          requestBody: {
            schema: {
              type: "object",
              required: ["data"],
              properties: {
                data: {
                  type: "object",
                  properties: {
                    visibility: { type: "string", enum: ["PRIVATE", "LINKED", "PUBLIC"] },
                    description: { type: ["string", "null"] },
                    tags: { type: "array", items: { type: "string" } },
                    name: { type: "string", maxLength: 255 },
                    folder: { type: ["string", "null"], format: "uuid" },
                  },
                },
              },
            },
          },
          response: { status: "200", schema: dataEnvelope(FILE_REF) },
          visible: canOnTotalbaseResource(context, "files", "UPDATE"),
        },
      },
    }, async (request) => {
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      const body = optionalData<UpdateFileBody>(request.body);
      const columns = (["visibility", "description", "tags", "name", "folder"] as const).filter((key) => body[key] !== undefined);
      if (body.name !== undefined && typeof body.name !== "string") throw new TotalBaseError("INVALID_QUERY", "name must be a string.");
      if (body.folder !== undefined && body.folder !== null && typeof body.folder !== "string") throw new TotalBaseError("INVALID_QUERY", "folder must be a folder id or null.");
      const record = await updateFileAuthorized(context, dataPrincipal, request.params.id, columns, (files) => files.updateMetadata(request.params.id, {
        visibility: body.visibility,
        description: body.description,
        tags: body.tags,
        name: body.name,
        folder: body.folder,
      }), body.visibility);
      return { data: publicFile(record) };
    });

    // Replace a file's content - JSON `{ data: { content } }` (UTF-8 text, the text
    // editor) or multipart (binary, e.g. an edited image), like the Admin
    // API's own route, for anyone granted UPDATE on the file.
    scoped.put<{ Params: { id: string }; Body: { data?: { content?: unknown } } | null }>("/api/totalbase/table/files/:id/content", {
      config: {
        openapi: {
          ...FILES_DOC,
          summary: "Replace a file's content",
          description: "JSON `{ \"data\": { \"content\": \"...\" } }` stores UTF-8 text; a multipart upload's `file` field stores binary content.",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          requestBody: {
            schema: {
              type: "object",
              required: ["data"],
              properties: { data: { type: "object", required: ["content"], properties: { content: { type: "string", description: "UTF-8 text." } } } },
            },
          },
          response: { status: "200", schema: dataEnvelope(FILE_REF) },
          visible: canOnTotalbaseResource(context, "files", "UPDATE"),
        },
      },
    }, async (request) => {
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      let content: Buffer;
      if (request.isMultipart()) {
        content = (await readUploadedFile(context, request)).content;
      } else {
        const text = optionalData<{ content: unknown }>(request.body).content;
        if (typeof text !== "string") throw new TotalBaseError("INVALID_QUERY", "content must be a string.");
        content = Buffer.from(text, "utf8");
      }
      const record = await updateFileAuthorized(context, dataPrincipal, request.params.id, [], (files) =>
        files.updateContent(request.params.id, content));
      return { data: publicFile(record) };
    });

    scoped.delete<{ Params: { id: string } }>("/api/totalbase/table/files/:id", {
      config: {
        openapi: {
          ...FILES_DOC,
          summary: "Delete a file",
          pathParameters: { id: { schema: { type: "string", format: "uuid" } } },
          response: { status: "204" },
          visible: canOnTotalbaseResource(context, "files", "DELETE"),
        },
      },
    }, async (request, reply) => {
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      await assertFileActionAllowed(context, dataPrincipal, request.params.id, "DELETE", await rowFilterLimits(context));
      await context.filesAdmin.remove(request.params.id);
      reply.code(204);
    });
  });
}
