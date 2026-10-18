import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { TotalBaseError } from "@totalbase/errors";
import { FilesAdminService, type FileRecord } from "@totalbase/files";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import {
  assertColumnsGranted,
  assertFileActionAllowed,
  assertFileCreateAllowed,
  assertFileReadAllowed,
  resolveTableGrant,
  rowFilterLimits,
  rowPassesGrant,
} from "@totalbase/mutations";
import type { DataPrincipal } from "../data-principal.js";
import { dataEnvelope, type ParameterObject } from "@totalbase/openapi";
import { canOnTotalbaseResource, FILE_REF, FILE_SCHEMAS } from "../openapi-docs.js";
import { optionalData } from "../request-body.js";

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
): Promise<FileRecord> {
  const grant = await resolveTableGrant(context, dataPrincipal, "files", "UPDATE", "FILE_ACCESS_DENIED");
  assertColumnsGranted(grant, [...columns], "FILE_ACCESS_DENIED");
  const limits = await rowFilterLimits(context);
  return context.database.transaction(async (client) => {
    if (!(await rowPassesGrant(client, context, dataPrincipal, grant, fileId, limits))) {
      throw new TotalBaseError("FILE_ACCESS_DENIED", "UPDATE is not authorized for Files.");
    }
    const record = await change(new FilesAdminService(client, context.settings));
    if (!(await rowPassesGrant(client, context, dataPrincipal, grant, fileId, limits))) {
      throw new TotalBaseError("FILE_ACCESS_DENIED", "The file would no longer satisfy your permission's row filter.");
    }
    return record;
  }, { actorUserId: dataPrincipal.actorUserId });
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
  visibility?: "PRIVATE" | "PUBLIC";
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
                visibility: { type: "string", enum: ["PRIVATE", "PUBLIC"], default: "PRIVATE" },
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
      await assertFileCreateAllowed(context, dataPrincipal);

      const file = await request.file();
      if (!file) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A multipart 'file' field is required.");
      const content = await file.toBuffer();
      const fields = file.fields as Record<string, { value?: string } | undefined>;
      const folderValue = fields.folder?.value;

      const record = await context.filesAdmin.upload({
        folder: folderValue ? folderValue : null,
        content,
        filename: file.filename,
        declaredContentType: file.mimetype,
        visibility: fields.visibility?.value === "PUBLIC" ? "PUBLIC" : "PRIVATE",
        description: fields.description?.value,
        tags: parseTagsField(fields.tags?.value),
        actorUserId: dataPrincipal.actorUserId ?? undefined,
      });
      reply.code(201);
      return { data: publicFile(record) };
    });

    // Content and info share the same authorization rule, except that a
    // public file bypasses it entirely.
    async function authorizeRead(request: FastifyRequest<{ Params: { id: string } }>) {
      const file = await context.filesAdmin.get(request.params.id);
      if (file.visibility === "PUBLIC") return file;
      const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), undefined, request);
      await assertFileReadAllowed(context, dataPrincipal, file);
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
        const file = await authorizeRead(request);
        const transformed = file.checksum
          ? await context.filesTransform.resolve({
              fileId: file.id,
              sourceHash: file.checksum,
              mimeType: file.mime_type,
              query: request.query,
              readOriginal: async () => (await context.filesAdmin.readContent(file.id)).content,
            })
          : undefined;

        if (transformed) {
          reply.header("content-type", transformed.contentType);
          reply.header("cache-control", `private, max-age=${transformed.cacheTtlSeconds}`);
          return reply.send(transformed.buffer);
        }

        const { content } = await context.filesAdmin.readContent(file.id);
        reply.header("content-type", file.mime_type);
        reply.header("content-disposition", `inline; filename="${encodeURIComponent(file.name)}"`);
        if (file.checksum) reply.header("etag", `"${file.checksum}"`);
        return reply.send(content);
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
      data: publicFile(await authorizeRead(request)),
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
                    visibility: { type: "string", enum: ["PRIVATE", "PUBLIC"] },
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
      }));
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
        const file = await request.file();
        if (!file) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A multipart 'file' field is required.");
        content = await file.toBuffer();
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
