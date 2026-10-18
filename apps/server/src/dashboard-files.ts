import { UUID_PATTERN } from "@totalbase/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";
import { dashboardValueKind } from "@totalbase/tb-catalog";
import type { DashboardQueryResult } from "@totalbase/dashboards";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "./context.js";

/**
 * A dashboard widget's files (Specification_Dashboards.md §5.16, D14): each file its query returned - a photo of a
 * PRIVATE file column - comes with a link TotalBase signs: this dashboard, this widget, this file, 15 minutes. The
 * link's route only checks the signature (it doesn't run the query again) and serves the file; it opens nothing
 * else. In an embed, a file that isn't PUBLIC is served only with the embed's `allowFiles` - a public link doesn't
 * show a PRIVATE photo without that decision.
 */

const TTL_SECONDS = 15 * 60;

interface FileClaims {
  /** The dashboard's id. */
  d: string;
  /** The widget's id. */
  w: string;
  /** The file's id. */
  f: string;
  /** The embed's id - an embed's link only. */
  e: string | null;
  /** Expiry, in seconds since the epoch. */
  x: number;
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signDashboardFile(key: Buffer, claims: Omit<FileClaims, "x">, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, x: Math.floor(now / 1000) + TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(key, payload)}`;
}

/** The claims of a link's token - DASHBOARD_FILE_TOKEN_INVALID when it was altered, expired, or names another file. */
export function verifyDashboardFile(key: Buffer, token: unknown, expected: { widget: string; file: string; embed: string | null }, now = Date.now()): FileClaims {
  const invalid = () => new TotalBaseError("DASHBOARD_FILE_TOKEN_INVALID", "This file's link isn't valid or has expired - reload the dashboard for a new one.");
  if (typeof token !== "string") throw invalid();
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw invalid();
  const good = Buffer.from(sign(key, payload));
  const given = Buffer.from(signature);
  if (good.length !== given.length || !timingSafeEqual(good, given)) throw invalid();
  let claims: FileClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FileClaims;
  } catch {
    throw invalid();
  }
  if (claims.x * 1000 < now || claims.w !== expected.widget || claims.f !== expected.file || (claims.e ?? null) !== expected.embed) throw invalid();
  return claims;
}

/** What a widget's file column holds, for the screen: its signed URL (null where it isn't served), name and type. */
export interface DashboardFileLink {
  url: string | null;
  name: string;
  mimeType: string;
  /** An image, drawn in line; anything else is a download. */
  image: boolean;
  /** Not served here: an embed's PRIVATE file without allowFiles - "Image not available on this link". */
  blocked?: true;
}

/**
 * A run's result with `files`: each file a file column returned, its link signed for this widget - `route` is where
 * the link's route is (`/app/api/dashboards/<id>/widgets/<widget>/files`, an embed's own); `embed` an embed's id and
 * whether it serves files that aren't PUBLIC.
 */
export async function withFileLinks<T extends DashboardQueryResult>(
  context: AppContext,
  result: T,
  scope: { dashboardId: string; widgetId: string; route: string; embed?: { id: string; allowFiles: boolean } },
): Promise<T & { files: Record<string, DashboardFileLink> | null }> {
  const fileColumns = result.columns.filter((c) => dashboardValueKind(c) === "file").map((c) => c.name);
  const ids = [...new Set(result.rows.flatMap((row) => fileColumns.map((name) => row[name]).filter((v): v is string => typeof v === "string" && UUID_PATTERN.test(v))))];
  if (ids.length === 0) return { ...result, files: null };
  const { rows } = await context.database.query<{ id: string; name: string; mime_type: string; visibility: string }>(
    `SELECT id, name, mime_type, visibility FROM totalbase.files WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const files: Record<string, DashboardFileLink> = {};
  for (const file of rows) {
    const blocked = scope.embed !== undefined && file.visibility !== "PUBLIC" && !scope.embed.allowFiles;
    const token = blocked ? null : signDashboardFile(context.dashboardFilesKey, { d: scope.dashboardId, w: scope.widgetId, f: file.id, e: scope.embed?.id ?? null });
    files[file.id] = {
      url: token ? `${scope.route}/${file.id}?token=${encodeURIComponent(token)}` : null,
      name: file.name,
      mimeType: file.mime_type,
      image: file.mime_type.startsWith("image/"),
      ...(blocked && { blocked: true as const }),
    };
  }
  return { ...result, files };
}

/**
 * Serves a widget's file by its signed link - an image in line (a thumbnail with `w`/`h`, the files' transforms),
 * anything else as a download. `allowed` decides, for an embed, a file that isn't PUBLIC.
 */
export async function serveDashboardFile(
  context: AppContext,
  reply: FastifyReply,
  fileId: string,
  query: Record<string, string | undefined>,
  allowed: (visibility: string) => boolean,
): Promise<FastifyReply> {
  const file = await context.filesAdmin.get(fileId);
  if (!allowed(file.visibility)) throw new TotalBaseError("DASHBOARD_FILE_NOT_ALLOWED", "This embed doesn't show files that aren't public (its allowFiles is off).");
  const { token: _token, ...transform } = query;
  const transformed = file.checksum && Object.keys(transform).length > 0
    ? await context.filesTransform.resolve({ fileId: file.id, sourceHash: file.checksum, mimeType: file.mime_type, query: transform, readOriginal: async () => (await context.filesAdmin.readContent(file.id)).content })
    : undefined;
  reply.header("cache-control", "private, max-age=600");
  if (transformed) {
    reply.header("content-type", transformed.contentType);
    return reply.send(transformed.buffer);
  }
  const { content } = await context.filesAdmin.readContent(file.id);
  reply.header("content-type", file.mime_type);
  reply.header("content-disposition", `${file.mime_type.startsWith("image/") ? "inline" : "attachment"}; filename="${encodeURIComponent(file.name)}"`);
  return reply.send(content);
}
