import type { FastifyInstance } from "fastify";
import { assertPasswordStrength } from "@totalbase/auth";
import { TotalBaseError } from "@totalbase/errors";
import { isUiLanguage } from "@totalbase/shared";
import type { AppContext } from "../context.js";
import { createInstanceOwner } from "../admin-bootstrap.js";
import { object, ok, created, UUID } from "../openapi-admin-docs.js";
import { requestData, type DataBody } from "../request-body.js";
import { finishSetup, setupCodeMatches } from "../setup.js";
import { signal } from "../invalidations.js";

/**
 * The first-start setup (Foundations.md §14.1): whether the instance still needs its first administrator, and
 * creating it with the code - from /admin/setup or from a program (TotalBase Manager). Public: the code is the
 * credential. Gone (404) once an administrator exists.
 */
interface SetupBody { code?: unknown; email?: unknown; name?: unknown; password?: unknown; publicUrl?: unknown; language?: unknown }

/** Wrong codes, per process: at most 10 in 10 minutes - an 80-bit code needs no more, a guesser gets no more. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;

export function registerSetupRoutes(app: FastifyInstance, context: AppContext): void {
  let failures: number[] = [];

  app.get("/api/setup", {
    config: {
      public: true,
      openapi: {
        summary: "Whether the instance needs its first administrator",
        tags: ["auth"],
        access: "public",
        response: ok(object({ required: { type: "boolean" } }, ["required"])),
      },
    },
  }, async () => ({ data: { required: context.setup.code !== null } }));

  app.post<{ Body: DataBody<SetupBody> }>("/api/setup", {
    config: {
      public: true,
      openapi: {
        summary: "Create the first administrator",
        description:
          "With the setup code (the server's log, its data directory's setup-code file, or TOTALBASE_SETUP_CODE): the instance owner, " +
          "and optionally the public URL and the language. Single use - 404 once an administrator exists. A wrong code is 403 " +
          "INVALID_SETUP_CODE; ten in ten minutes, 429.",
        tags: ["auth"],
        access: "public",
        requestBody: { schema: { type: "object", properties: { data: object({
          code: { type: "string" }, email: { type: "string", format: "email" }, name: { type: "string" }, password: { type: "string" },
          publicUrl: { type: "string", description: "The address users reach the instance at (system.public_url)." },
          language: { type: "string", description: "The instance's language (system.language): en or es." },
        }, ["code", "email", "password"]) } } },
        response: created(object({ userId: UUID }, ["userId"])),
      },
    },
  }, async (request, reply) => {
    if (context.setup.code === null) throw new TotalBaseError("RESOURCE_NOT_FOUND", "This instance is already set up.");
    const now = Date.now();
    failures = failures.filter((at) => now - at < WINDOW_MS);
    if (failures.length >= MAX_FAILURES) throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many wrong setup codes - wait a few minutes.");
    const body = requestData(request.body);
    if (!setupCodeMatches(context.setup, body.code)) {
      failures.push(now);
      throw new TotalBaseError("INVALID_SETUP_CODE", "That setup code isn't this instance's - it's in the server's log.");
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TotalBaseError("INVALID_FIELD", "email must be an email address.");
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Administrator";
    if (typeof body.password !== "string") throw new TotalBaseError("INVALID_FIELD", "password is required.");
    assertPasswordStrength(body.password, await context.settings.get("auth.password_min_length"));
    if (body.language !== undefined && !isUiLanguage(body.language)) throw new TotalBaseError("INVALID_FIELD", "language must be en or es.");
    // The settings first (each validated by the registry): a refused URL creates no owner.
    if (typeof body.publicUrl === "string" && body.publicUrl.trim()) await context.settings.set("system.public_url", body.publicUrl.trim().replace(/\/+$/, ""));
    if (isUiLanguage(body.language)) await context.settings.set("system.language", body.language);
    const userId = await createInstanceOwner(context.database, { email, name, password: body.password });
    if (userId === null) {
      await finishSetup(context.setup);
      throw new TotalBaseError("RESOURCE_NOT_FOUND", "This instance is already set up.");
    }
    await finishSetup(context.setup);
    // Every other process forgets its code too (Foundations.md §4.6).
    await signal(context, { topic: "SETUP" });
    await context.audit.record(context.database, {
      requestId: request.id,
      principal: { type: "ADMIN", id: userId },
      action: "AUTH",
      status: "EXECUTED",
      source: "admin",
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: { event: "setup.completed", email },
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    reply.code(201);
    return { data: { userId } };
  });
}
