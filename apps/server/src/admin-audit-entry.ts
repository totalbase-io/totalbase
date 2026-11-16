import type { AuditLogEntry } from "@totalbase/audit";
import type { FastifyRequest } from "fastify";

/**
 * An audit row an administrator's request writes (Security.md §11.2): who (the administrator), which request,
 * from where (IP, user agent), with which admin-plane token if any (`metadata.token`) and when - filled from the
 * request, so every admin route records them alike. The caller gives what happened. `startedAt` defaults to now.
 */
export function adminAuditEntry(
  request: FastifyRequest,
  entry: Omit<AuditLogEntry, "requestId" | "principal" | "source" | "ip" | "userAgent" | "startedAt" | "finishedAt"> & { startedAt?: Date },
): AuditLogEntry {
  const metadata = request.adminToken
    ? { ...(entry.metadata as Record<string, unknown> | undefined), token: request.adminToken }
    : entry.metadata;
  return {
    ...entry,
    requestId: request.id,
    principal: { type: "ADMIN", id: request.admin!.id },
    source: "admin",
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    ...(metadata !== undefined && { metadata }),
    startedAt: entry.startedAt ?? new Date(),
    finishedAt: new Date(),
  };
}
