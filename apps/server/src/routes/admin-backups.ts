import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Backup } from "@totalbase/backups";
import type { JsonSchema } from "@totalbase/openapi";
import { TotalBaseError } from "@totalbase/errors";
import { UUID_PATTERN } from "@totalbase/shared";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, DATE_TIME, NO_CONTENT, object, ok, UUID } from "../openapi-admin-docs.js";

const NULLABLE_DATE_TIME: JsonSchema = { ...DATE_TIME, type: ["string", "null"] };

const BACKUP: JsonSchema = object(
  {
    id: UUID,
    status: { type: "string", enum: ["PENDING", "RUNNING", "COMPLETED", "FAILED"] },
    trigger: { type: "string", enum: ["SCHEDULED", "MANUAL"] },
    scheduledFor: { ...NULLABLE_DATE_TIME, description: "The schedule's occurrence it ran for - null for Back up now." },
    requestedBy: { type: ["string", "null"], format: "uuid", description: "Who asked for it - null for a scheduled one." },
    destination: { type: "string", enum: ["LOCAL", "S3"] },
    name: { type: "string", description: "The archive's file name - its key at the destination." },
    sizeBytes: { type: ["integer", "null"] },
    manifest: { type: ["object", "null"], description: "What the archive holds: versions, the last migration applied, whether files are in it." },
    error: { type: ["string", "null"], description: "Why it failed - pg_dump's own words, the destination's." },
    createdAt: DATE_TIME,
    startedAt: NULLABLE_DATE_TIME,
    completedAt: NULLABLE_DATE_TIME,
  },
  ["id", "status", "trigger", "destination", "name", "createdAt"],
);

/** A path's backup id: one that can't be an id names no backup - 404, like one that matches nothing. */
function pathId(raw: string): string {
  if (!UUID_PATTERN.test(raw)) throw new TotalBaseError("BACKUP_NOT_FOUND", "Backup not found.");
  return raw;
}

/** How long a download link works - long enough for the browser to follow it, too short to share. */
const DOWNLOAD_LINK_SECONDS = 60;

function downloadSignature(context: AppContext, id: string, admin: string, expires: number): string {
  return createHmac("sha256", context.backupDownloadKey).update(`${id}.${admin}.${expires}`).digest("hex");
}

/** A download link's signature, checked in constant time - wrong or expired names no archive. */
function verifyDownload(context: AppContext, id: string, query: { admin?: string; expires?: string; signature?: string }): string {
  const expires = Number(query.expires);
  const admin = query.admin ?? "";
  if (!UUID_PATTERN.test(admin) || !Number.isInteger(expires) || typeof query.signature !== "string") throw new TotalBaseError("BACKUP_NOT_FOUND", "Backup not found.");
  const expected = Buffer.from(downloadSignature(context, id, admin, expires), "hex");
  const given = Buffer.from(query.signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TotalBaseError("BACKUP_NOT_FOUND", "Backup not found.");
  if (expires < Math.floor(Date.now() / 1000)) throw new TotalBaseError("BACKUP_NOT_FOUND", "The download link expired - download it again from Settings › PostgreSQL › Backups.");
  return admin;
}

/** The manifest's master key verifier is never sent - it adds nothing an administrator acts on. */
function publicBackup(backup: Backup) {
  if (!backup.manifest) return backup;
  const { masterKeyVerifier: _verifier, ...manifest } = backup.manifest;
  return { ...backup, manifest };
}

/**
 * Built-in backups (Administration.md §12) - Settings > PostgreSQL > Backups.
 * Not plain row operations - each queues pg_dump or moves an archive - so
 * Admin API routes, administrators only; @totalbase/backups does the work.
 */
export function registerAdminBackupsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get<{ Querystring: { page?: string; limit?: string } }>("/admin/api/backups", {
    preHandler,
    ...adminDoc("backups", {
      summary: "Backups, newest first",
      description: "A page of backups - queued, running, completed or failed - and, in `meta`, how many there are and the schedule: on or off, its next occurrence, the destination new backups go to.",
      parameters: [
        { name: "page", in: "query", required: false, description: "From 1 (the default).", schema: { type: "integer", minimum: 1 } },
        { name: "limit", in: "query", required: false, description: "Backups per page: 20 by default, at most 100.", schema: { type: "integer", minimum: 1, maximum: 100 } },
      ],
      response: {
        status: "200",
        schema: object(
          {
            data: arrayOf(BACKUP),
            meta: object({ total: { type: "integer" }, enabled: { type: "boolean" }, schedule: { type: "string" }, timezone: { type: "string" }, nextAt: NULLABLE_DATE_TIME, destination: { type: "string", enum: ["LOCAL", "S3"] } }, ["total", "enabled", "schedule", "timezone", "nextAt", "destination"]),
          },
          ["data", "meta"],
        ),
      },
    }),
  }, async (request) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit ?? "", 10) || 20));
    const page = Math.max(1, Number.parseInt(request.query.page ?? "", 10) || 1);
    const [backups, total, overview] = await Promise.all([context.backups.list(limit, (page - 1) * limit), context.backups.count(), context.backups.overview()]);
    return { data: backups.map(publicBackup), meta: { total, ...overview } };
  });

  app.post("/admin/api/backups", {
    preHandler,
    ...adminDoc("backups", {
      summary: "Back up now",
      description: "Queues a backup for the worker, written to the current destination; follow it with GET /admin/api/backups. 409 BACKUP_ALREADY_QUEUED while another is queued or running.",
      response: { status: "202", schema: object({ data: BACKUP }, ["data"]) },
    }),
  }, async (request, reply) => {
    const backup = await context.backups.requestNow(request.admin!.id, request.id);
    reply.code(202);
    return { data: publicBackup(backup) };
  });

  app.post<{ Params: { id: string } }>("/admin/api/backups/:id/download", {
    preHandler,
    ...adminDoc("backups", {
      summary: "A download link for a backup's archive",
      description:
        "A link the browser follows to download the archive (a tar: manifest.json, database.dump, files.tar - what `totalbase restore` takes), " +
        `signed for this administrator and valid ${DOWNLOAD_LINK_SECONDS} seconds: an archive may be too large to pass through the page. ` +
        "409 BACKUP_RUNNING while it runs; 404 BACKUP_NOT_FOUND for a failed one.",
      pathParameters: { id: { schema: UUID } },
      response: ok(object({ url: { type: "string" }, expiresAt: DATE_TIME }, ["url", "expiresAt"])),
    }),
  }, async (request) => {
    const backup = await context.backups.get(pathId(request.params.id));
    if (backup.status === "PENDING" || backup.status === "RUNNING") throw new TotalBaseError("BACKUP_RUNNING", "The backup hasn't finished yet.");
    if (backup.status !== "COMPLETED") throw new TotalBaseError("BACKUP_NOT_FOUND", "The backup failed - it has no archive.");
    const admin = request.admin!.id;
    const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_SECONDS;
    const query = new URLSearchParams({ admin, expires: String(expires), signature: downloadSignature(context, backup.id, admin, expires) });
    return { data: { url: `/admin/api/backups/${backup.id}/archive?${query}`, expiresAt: new Date(expires * 1000).toISOString() } };
  });

  // Followed by the browser itself, so no Authorization header: the link's signature is its credential.
  app.get<{ Params: { id: string }; Querystring: { admin?: string; expires?: string; signature?: string } }>("/admin/api/backups/:id/archive", {
    ...adminDoc("backups", {
      summary: "Download a backup's archive",
      description: "Streams the archive, with a link from POST /admin/api/backups/{id}/download - its signature, not a session, authorizes it. Audited.",
      access: "public",
      pathParameters: { id: { schema: UUID } },
      parameters: [
        { name: "admin", in: "query", required: true, description: "The administrator the link was signed for.", schema: UUID },
        { name: "expires", in: "query", required: true, description: "When the link stops working (Unix seconds).", schema: { type: "integer" } },
        { name: "signature", in: "query", required: true, description: "The link's signature.", schema: { type: "string" } },
      ],
      response: { status: "200", contentType: "application/x-tar", schema: { type: "string", format: "binary" }, description: "The archive." },
    }),
  }, async (request, reply) => {
    const id = pathId(request.params.id);
    const admin = verifyDownload(context, id, request.query);
    const { backup, stream } = await context.backups.download(id, admin, request.id);
    reply.header("content-type", "application/x-tar");
    reply.header("content-disposition", `attachment; filename="${backup.name}"`);
    if (backup.sizeBytes !== null) reply.header("content-length", String(backup.sizeBytes));
    return reply.send(stream);
  });

  app.delete<{ Params: { id: string } }>("/admin/api/backups/:id", {
    preHandler,
    ...adminDoc("backups", {
      summary: "Delete a backup",
      description: "Deletes the backup and its archive at its destination. Audited. 409 BACKUP_RUNNING while it is queued or running.",
      pathParameters: { id: { schema: UUID } },
      response: NO_CONTENT,
    }),
  }, async (request, reply) => {
    await context.backups.delete(pathId(request.params.id), request.admin!.id, request.id);
    reply.code(204);
  });
}
