import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { adminAuditEntry } from "./admin-audit-entry.js";

const request = (adminToken?: string) => ({
  id: "req-1",
  ip: "10.0.0.1",
  headers: { "user-agent": "tests" },
  admin: { id: "admin-1" },
  adminToken,
}) as unknown as FastifyRequest;

describe("adminAuditEntry", () => {
  it("fills who, which request and from where from the request", () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    expect(adminAuditEntry(request(), { action: "MAINTENANCE", status: "EXECUTED", metadata: { batch: "b" }, startedAt })).toMatchObject({
      requestId: "req-1",
      principal: { type: "ADMIN", id: "admin-1" },
      source: "admin",
      ip: "10.0.0.1",
      userAgent: "tests",
      action: "MAINTENANCE",
      metadata: { batch: "b" },
      startedAt,
    });
  });

  it("adds the admin-plane token to the metadata, and leaves metadata out when there is none", () => {
    expect(adminAuditEntry(request("tok-1"), { action: "AUTH", status: "EXECUTED", metadata: { event: "x" } }).metadata).toEqual({ event: "x", token: "tok-1" });
    expect(adminAuditEntry(request("tok-1"), { action: "SQL_HISTORY_PURGE", status: "EXECUTED" }).metadata).toEqual({ token: "tok-1" });
    expect(adminAuditEntry(request(), { action: "SQL_HISTORY_PURGE", status: "EXECUTED" })).not.toHaveProperty("metadata");
  });
});
