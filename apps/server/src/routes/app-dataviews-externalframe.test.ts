import type { FastifyInstance } from "fastify";
import { hashPassword } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { adminToken as loginAdmin, cleanupTracked, setupTestApp, track, uniqueSuffix } from "../test-support.js";

const SUFFIX = uniqueSuffix();

/**
 * EXTERNALFRAME DataViews (DataViews.md,
 * "EXTERNALFRAME security"): created without a source, the URL validated
 * on create and update (https only, never the instance's own origin), and
 * opened in the App on object access alone - there is no source resource
 * to hold READ on.
 */
describe("EXTERNALFRAME DataViews", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let viewerToken: string;
  let roleId: string;
  let frameId: string;
  // Short: a slug is at most 32 characters.
  const SLUG = `extframe-${SUFFIX}`;
  const EMAIL = `externalframe-route-test-${SUFFIX}@example.com`;
  const PASSWORD = "externalframe-route-test-password";

  function request(method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: Record<string, unknown>) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = await loginAdmin(context);
    roleId = track("roles", (await context.roles.create(`externalframe-route-test-${SUFFIX}`)).id);
    const user = await context.auth.users.create({ email: EMAIL, name: EMAIL, passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    track("users", user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    const login = await app.inject({ method: "POST", url: "/admin/api/auth/login", payload: { email: EMAIL, password: PASSWORD } });
    viewerToken = login.json().data.token as string;
  });

  afterAll(async () => {
    await cleanupTracked(database);
    await app.close();
  });

  it("creates one without sourceResourceId", async () => {
    const res = await request("POST", "/admin/api/dataviews", adminToken, {
      data: {
        name: `External frame ${SUFFIX}`,
        slug: SLUG,
        description: "Report",
        viewType: "EXTERNALFRAME",
        viewConfig: { frame_url: "https://reports.example.com/r/1", features: { openInNewTab: true, fullscreen: false } },
      },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.sourceResource).toBeNull();
    expect(data.viewConfig.frame_url).toBe("https://reports.example.com/r/1");
    frameId = track("dataviews", data.id);
  });

  it("rejects unsafe URLs with 422 on create and update", async () => {
    const ownOrigin = new URL(await context.auth.mailer.publicUrl()).origin;
    for (const frameUrl of ["javascript:alert(1)", "http://reports.example.com", `${ownOrigin}/admin/`, "https://u:p@example.com"]) {
      const created = await request("POST", "/admin/api/dataviews", adminToken, {
        data: {
          name: "Bad frame",
          slug: `${SLUG}-bad`,
          viewType: "EXTERNALFRAME",
          viewConfig: { frame_url: frameUrl },
        },
      });
      expect(created.statusCode, frameUrl).toBe(422);
      expect(created.json().errors[0].code).toBe("DATAVIEW_FRAME_URL_INVALID");

      const patched = await request("PATCH", `/admin/api/dataviews/${frameId}`, adminToken, { data: { viewConfig: { frame_url: frameUrl } } });
      expect(patched.statusCode, frameUrl).toBe(422);
    }
    const unchanged = await request("GET", `/admin/api/dataviews/${frameId}`, adminToken);
    expect(unchanged.json().data.viewConfig.frame_url).toBe("https://reports.example.com/r/1");
  });

  it("the App opens it on object access alone - no source READ exists to require", async () => {
    expect((await request("POST", `/admin/api/dataviews/${frameId}/publish`, adminToken)).statusCode).toBe(201);

    // Not granted: missing, and not listed.
    expect((await request("GET", `/app/api/dataviews/${SLUG}`, viewerToken)).statusCode).toBe(404);
    const before = await request("GET", "/app/api/dataviews", viewerToken);
    expect((before.json().data as { id: string }[]).some((d) => d.id === frameId)).toBe(false);

    await context.dataviewsAdmin.setRoles(frameId, [roleId]);
    const opened = await request("GET", `/app/api/dataviews/${SLUG}`, viewerToken);
    expect(opened.statusCode).toBe(200);
    expect(opened.json().data.viewConfig.frame_url).toBe("https://reports.example.com/r/1");
    const after = await request("GET", "/app/api/dataviews", viewerToken);
    expect((after.json().data as { id: string }[]).some((d) => d.id === frameId)).toBe(true);
  });
});
