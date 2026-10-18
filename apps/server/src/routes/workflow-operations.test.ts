import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { EmailSendInput } from "@totalbase/auth";
import type { Database } from "@totalbase/database";
import { validateExecutionReadiness } from "@totalbase/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createTestApiToken, setupTestApp } from "../test-support.js";

const PREFIX = "wfop";

/**
 * Workflow operations (Specification_Workflows.md §5), run as a
 * non-administrator executor through POST /api/workflows/{slug}/run:
 *
 * - Update/Delete records honor api.require_where_for_update/_delete, at
 *   publish and at run time (§5.4, §5.5);
 * - Validate data (§5.9.1);
 * - HTTP request refuses private/loopback destinations unless
 *   workflows.http_allowed_hosts lists them (§5.15) - security regression;
 * - Execute function runs with totalbase.actor_user_id set to the executor
 *   (Data API §2.7), like a record write;
 * - Send email from a MAILING template and Generate PDF from template need
 *   the executor's READ on the template row (§5.16, §5.22) - security
 *   regression for the PDF step, which rendered any template.
 */
describe("workflow operations", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let templatesResourceId: string;
  let caller: { plainKey: string; userId: string; tokenId: string };
  let server: Server;
  let serverPort: number;
  let originalEmailSender: AppContext["emailSender"];
  const sent: EmailSendInput[] = [];
  const workflowIds: string[] = [];
  const templateIds: string[] = [];

  const run = (slug: string, data: unknown = {}) =>
    app.inject({
      method: "POST",
      url: `/api/workflows/${slug}/run`,
      headers: { authorization: `Bearer ${caller.plainKey}`, "content-type": "application/json" },
      payload: JSON.stringify({ data }),
    });

  function definitionWith(step: { type: string; configuration: Record<string, unknown> }) {
    const startId = randomUUID();
    const stepId = randomUUID();
    const finishId = randomUUID();
    return {
      operations: [
        { id: startId, type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration: { trigger: "MANUAL" } },
        { id: stepId, type: step.type, configuration_version: 1, label: "Step", key: "step", configuration: step.configuration },
        { id: finishId, type: "totalbase.finish-result", configuration_version: 1, label: "Done", key: "finish", configuration: { result: "{{step.data}}" } },
      ],
      connections: [
        { source: startId, target: stepId, output: "next" },
        { source: stepId, target: finishId, output: "next" },
      ],
    };
  }

  async function draftWorkflow(slug: string, step: { type: string; configuration: Record<string, unknown> }): Promise<string> {
    const workflows = context.workflowsAdmin;
    const id = (await workflows.create({ name: slug, slug })).id;
    workflowIds.push(id);
    await workflows.saveDraft(id, (await workflows.get(id)).revision, definitionWith(step));
    return id;
  }

  const publish = async (id: string) => context.workflowsAdmin.publish(id, (await context.workflowsAdmin.get(id)).revision, (definition) => validateExecutionReadiness(definition, context));

  /** Start -> step -> Finish({{step.data}}), published, enabled and invocable by the caller's role. The step's error output is unconnected: a failure fails the run with its code. */
  async function publishedWorkflow(slug: string, step: { type: string; configuration: Record<string, unknown> }): Promise<string> {
    const id = await draftWorkflow(slug, step);
    await publish(id);
    await context.workflowsAdmin.update(id, { revision: (await context.workflowsAdmin.get(id)).revision, enabled: true });
    await context.workflowPermissions.grant(roleId, id);
    return id;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    templatesResourceId = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'templates'`,
    )).rows[0]!.id;
    roleId = (await context.roles.create(`${PREFIX}-caller`, { apiAccess: true })).id;
    caller = await createTestApiToken(context, { name: `${PREFIX}-caller`, roleId, email: `${PREFIX}-caller@example.com` });

    originalEmailSender = context.emailSender;
    context.emailSender = { send: async (input: EmailSendInput) => { sent.push(input); } } as AppContext["emailSender"];

    server = createServer((request, response) => {
      if (request.url === "/redirect-to-loopback") {
        response.writeHead(302, { location: `http://127.0.0.1:${serverPort}/ok` }).end();
        return;
      }
      if (request.url === "/big") {
        response.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(8192));
        return;
      }
      if (request.url === "/fail") {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "boom" }));
        return;
      }
      if (request.url === "/soap") {
        // A SOAP 1.1 service: echoes the operation's parameters back (one or two `item`s), a Fault for id 0, plain text for id 9.
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { raw += chunk; });
        request.on("end", () => {
          const id = /<id>(\d+)<\/id>/.exec(raw)?.[1] ?? "";
          const action = request.headers.soapaction ?? "";
          if (id === "9") {
            response.writeHead(200, { "content-type": "text/plain" }).end("not xml");
            return;
          }
          if (id === "0") {
            response.writeHead(500, { "content-type": "text/xml" }).end(`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>No existe persona con ese Id</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`);
            return;
          }
          const items = id === "2" ? "<item>a</item><item>b</item>" : "<item>a</item>";
          const op = /<ns:(\w+)/.exec(raw)?.[1] ?? "";
          response.writeHead(200, { "content-type": "text/xml;charset=utf-8" }).end(`<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:${op}Response xmlns:ns2="urn:test"><return><id>${id}</id><name>${/<name>([^<]*)<\/name>/.exec(raw)?.[1] ?? ""}</name><zip>0123</zip><action>${action}</action>${items}<secret>${request.headers["x-api-key"] ?? ""}</secret></return></ns2:${op}Response></S:Body></S:Envelope>`);
        });
        return;
      }
      // Echoes what a step may set: the path, the method and a secret header's value.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, path: request.url, method: request.method, key: request.headers["x-api-key"] ?? null }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    context.emailSender = originalEmailSender;
    await context.settings.reset("api.require_where_for_update");
    await context.settings.reset("api.require_where_for_delete");
    await context.settings.reset("workflows.http_allowed_hosts");
    await new Promise((resolve) => server.close(resolve));
    await database.query(`DELETE FROM totalbase.workflows WHERE id = ANY($1)`, [workflowIds]);
    await database.query(`DELETE FROM totalbase.templates WHERE id = ANY($1)`, [templateIds]);
    await database.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [caller.userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
  });

  describe("Execute function", () => {
    let functionResourceId: string;

    beforeAll(async () => {
      await database.query(`DROP FUNCTION IF EXISTS public.wfop_actor()`);
      await database.query(`CREATE FUNCTION public.wfop_actor() RETURNS text LANGUAGE sql AS $$SELECT current_setting('totalbase.actor_user_id', true)$$`);
      functionResourceId = (await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES (to_regprocedure('public.wfop_actor()')::oid, 'public', 'wfop_actor', 'FUNCTION', 'ACTIVE', '{POST}') RETURNING id`,
      )).rows[0]!.id;
      await context.permissions.set(roleId, functionResourceId, "EXECUTE", { effect: "ALLOW" });
    });

    afterAll(async () => {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [functionResourceId]);
      await database.query(`DROP FUNCTION IF EXISTS public.wfop_actor()`);
    });

    it("runs the function with totalbase.actor_user_id set to the executor", async () => {
      await publishedWorkflow(`${PREFIX}-fn-actor`, { type: "totalbase.execute-function", configuration: { function: functionResourceId, arguments: {} } });
      const res = await run(`${PREFIX}-fn-actor`);
      expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: caller.userId } });
    });
  });

  describe("Update/Delete records and api.require_where_for_*", () => {
    // A real table: publish checks a step's table exists (Specification_Workflows.md §3.5). Marked MISSING
    // after publishing, it shows which check stopped the step at run time - the guard runs before the resource is resolved.
    let missingResource: string;
    beforeAll(async () => {
      await database.query(`DROP TABLE IF EXISTS public.wfop_where_items`);
      await database.query(`CREATE TABLE public.wfop_where_items (id integer PRIMARY KEY, a integer)`);
      missingResource = (await database.query<{ id: string }>(
        `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
         VALUES (to_regclass('public.wfop_where_items')::oid, 'public', 'wfop_where_items', 'TABLE', 'ACTIVE', '{GET}') RETURNING id`,
      )).rows[0]!.id;
    });
    afterAll(async () => {
      await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [missingResource]);
      await database.query(`DROP TABLE IF EXISTS public.wfop_where_items`);
    });

    it("refuses to publish a step without where while the setting is on", async () => {
      for (const [type, slug, configuration] of [
        ["totalbase.update-records", `${PREFIX}-upd-nowhere`, { resource: missingResource, set: { a: 1 }, where: {} }],
        ["totalbase.delete-records", `${PREFIX}-del-nowhere`, { resource: missingResource, where: {} }],
      ] as const) {
        const id = await draftWorkflow(slug, { type, configuration });
        await expect(publish(id)).rejects.toMatchObject({ code: "WORKFLOW_NOT_PUBLISHABLE" });
      }
    });

    it("publishes with a where, or without one when the setting is off", async () => {
      const withWhere = await draftWorkflow(`${PREFIX}-upd-where`, { type: "totalbase.update-records", configuration: { resource: missingResource, set: { a: 1 }, where: { id: { _eq: "1" } } } });
      await expect(publish(withWhere)).resolves.toBeTruthy();
      await context.settings.set("api.require_where_for_delete", false);
      try {
        const id = await draftWorkflow(`${PREFIX}-del-off`, { type: "totalbase.delete-records", configuration: { resource: missingResource } });
        await expect(publish(id)).resolves.toBeTruthy();
      } finally {
        await context.settings.reset("api.require_where_for_delete");
      }
    });

    it("fails at run time with the Data API's INVALID_QUERY when the setting was turned on after publishing", async () => {
      await context.settings.set("api.require_where_for_update", false);
      await context.settings.set("api.require_where_for_delete", false);
      await publishedWorkflow(`${PREFIX}-upd-run`, { type: "totalbase.update-records", configuration: { resource: missingResource, set: { a: 1 } } });
      await publishedWorkflow(`${PREFIX}-del-run`, { type: "totalbase.delete-records", configuration: { resource: missingResource } });
      await database.query(`UPDATE totalbase.resources SET status = 'MISSING' WHERE id = $1`, [missingResource]);

      // Off: the guard passes, the step goes on to resolve the resource.
      expect((await run(`${PREFIX}-del-run`)).json().data).toMatchObject({ status: "FAILED", error: { code: "RESOURCE_NOT_FOUND" } });

      await context.settings.reset("api.require_where_for_update");
      await context.settings.reset("api.require_where_for_delete");
      for (const slug of [`${PREFIX}-upd-run`, `${PREFIX}-del-run`]) {
        const res = await run(slug);
        expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "INVALID_QUERY" } });
      }
    });
  });

  describe("Validate data", () => {
    beforeAll(async () => {
      await publishedWorkflow(`${PREFIX}-validate`, {
        type: "totalbase.validate-data",
        configuration: {
          input: "{{start.data}}",
          rules: [
            { filter: { email: { _nnull: true } }, message: "Email is required." },
            { filter: { total: { _gt: "0" } }, message: "Total must be positive." },
          ],
        },
      });
    });

    it("passes the input on next when every rule holds", async () => {
      const res = await run(`${PREFIX}-validate`, { email: "a@example.com", total: 5 });
      expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { email: "a@example.com", total: 5 } } });
    });

    it("fails with WORKFLOW_VALIDATION_FAILED listing every failed rule's message", async () => {
      const res = await run(`${PREFIX}-validate`, { total: -1 });
      const data = res.json().data;
      expect(data, res.body).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_VALIDATION_FAILED" } });
      expect(data.error.message).toContain("Email is required.");
      expect(data.error.message).toContain("Total must be positive.");
    });
  });

  describe("SOAP request (§5.15.1)", () => {
    const SECRET = "wfop_soap_api_key";
    const step = (slug: string, configuration: Record<string, unknown>) =>
      publishedWorkflow(`${PREFIX}-${slug}`, { type: "totalbase.soap-request", configuration: { url: `http://127.0.0.1:${serverPort}/soap`, operation: "getPersona", namespace: "urn:test", ...configuration } });
    beforeAll(async () => {
      await context.settings.set("workflows.http_allowed_hosts", ["127.0.0.0/8"]);
      await context.secrets.set(SECRET, "soap-s3cr3t");
      await step("soap-one", { soapAction: "", body: { id: 1, name: "Tom & \"Jerry\" <b>", skip: null }, arrays: ["item"], secretHeaders: [{ name: "x-api-key", secret: SECRET }] });
      await step("soap-two", { soapAction: "urn:test#getPersona", body: { id: 2 } });
      await step("soap-fault", { body: { id: 0 } });
      await step("soap-text", { body: { id: 9 } });
      await step("soap-markup", { body: { "id><x": 1 } });
      await step("soap-blocked", { url: "http://169.254.169.254/soap", body: { id: 1 } });
    });
    afterAll(async () => {
      await context.settings.reset("workflows.http_allowed_hosts");
      await context.secrets.delete(SECRET);
    });

    it("builds the envelope, escapes values, leaves null out, sends an empty SOAPAction and a secret header, parses the answer", async () => {
      const res = await run(`${PREFIX}-soap-one`);
      const data = res.json().data;
      expect(data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { status: 200, body: { getPersonaResponse: { return: { id: 1, name: "Tom & \"Jerry\" <b>", zip: "0123", action: "\"\"", item: ["a"], secret: "soap-s3cr3t" } } } } } });
      expect(typeof data.result.data.durationMs).toBe("number");
      const { rows } = await database.query<{ definition: unknown }>(`SELECT definition FROM totalbase.workflows WHERE slug = $1`, [`${PREFIX}-soap-one`]);
      expect(JSON.stringify(rows[0]!.definition)).not.toContain("soap-s3cr3t");
    });

    it("sends the SOAPAction as given and reads a repeated element as a list without `arrays`", async () => {
      const res = await run(`${PREFIX}-soap-two`);
      expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { body: { getPersonaResponse: { return: { id: 2, action: "\"urn:test#getPersona\"", item: ["a", "b"] } } } } } });
    });

    it("fails the step with the service's Fault", async () => {
      const res = await run(`${PREFIX}-soap-fault`);
      expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_SOAP_FAULT", message: expect.stringContaining("No existe persona con ese Id") } });
    });

    it("fails on an answer that is not a SOAP envelope, on a key that is markup, and on a refused destination", async () => {
      expect((await run(`${PREFIX}-soap-text`)).json().data).toMatchObject({ status: "FAILED", error: { code: "INTERNAL_ERROR", message: expect.stringContaining("without a SOAP envelope") } });
      expect((await run(`${PREFIX}-soap-markup`)).json().data).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_INVALID_DESIGN", message: expect.stringContaining("not a valid XML element name") } });
      expect((await run(`${PREFIX}-soap-blocked`)).json().data).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_HTTP_DESTINATION_BLOCKED" } });
    });
  });

  describe("Sign (§5.15.2)", () => {
    const CERT = "wfop_sign_cert";
    const KEY = "wfop_sign_key";
    let dir: string;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "tb-wfop-sign-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", "2", "-subj", "/CN=wfop-sign"], { cwd: dir, stdio: "ignore" });
      await context.secrets.set(CERT, readFileSync(join(dir, "cert.pem"), "utf8"));
      await context.secrets.set(KEY, readFileSync(join(dir, "key.pem"), "utf8"));
      await publishedWorkflow(`${PREFIX}-sign`, { type: "totalbase.sign", configuration: { format: "CMS", data: "<ticket/>", certificate: CERT, privateKey: KEY } });
      await publishedWorkflow(`${PREFIX}-sign-missing`, { type: "totalbase.sign", configuration: { format: "CMS", data: "<ticket/>", certificate: CERT, privateKey: "wfop_sign_nope" } });
    });
    afterAll(async () => {
      await context.secrets.delete(CERT);
      await context.secrets.delete(KEY);
      rmSync(dir, { recursive: true, force: true });
    });

    it("signs with the secrets read at run time - their content never in the definition", async () => {
      const res = await run(`${PREFIX}-sign`);
      const data = res.json().data;
      expect(data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { format: "CMS", certificate: { subject: expect.stringContaining("CN=wfop-sign") } } } });
      expect(Buffer.from(data.result.data.signature, "base64").toString("binary")).toContain("<ticket/>");
      const { rows } = await database.query<{ definition: unknown }>(`SELECT definition FROM totalbase.workflows WHERE slug = $1`, [`${PREFIX}-sign`]);
      expect(JSON.stringify(rows[0]!.definition)).not.toContain("BEGIN");
    });

    it("fails with SECRET_NOT_FOUND when a secret doesn't exist", async () => {
      const res = await run(`${PREFIX}-sign-missing`);
      expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "SECRET_NOT_FOUND" } });
    });
  });

  describe("HTTP request outbound policy (SSRF)", () => {
    beforeAll(async () => {
      await publishedWorkflow(`${PREFIX}-http-ip`, { type: "totalbase.http-request", configuration: { method: "GET", url: `http://127.0.0.1:${serverPort}/ok` } });
      await publishedWorkflow(`${PREFIX}-http-name`, { type: "totalbase.http-request", configuration: { method: "GET", url: `http://localhost:${serverPort}/ok` } });
      await publishedWorkflow(`${PREFIX}-http-redirect`, { type: "totalbase.http-request", configuration: { method: "GET", url: `http://localhost:${serverPort}/redirect-to-loopback` } });
      await publishedWorkflow(`${PREFIX}-http-metadata`, { type: "totalbase.http-request", configuration: { method: "GET", url: "http://169.254.169.254/latest/meta-data/" } });
    });

    it("refuses loopback by IP and by a hostname resolving to it, and the cloud metadata address", async () => {
      for (const slug of [`${PREFIX}-http-ip`, `${PREFIX}-http-name`, `${PREFIX}-http-metadata`]) {
        const res = await run(slug);
        expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_HTTP_DESTINATION_BLOCKED" } });
      }
    });

    it("reaches a destination workflows.http_allowed_hosts lists, by CIDR or by hostname", async () => {
      await context.settings.set("workflows.http_allowed_hosts", ["127.0.0.0/8"]);
      try {
        const res = await run(`${PREFIX}-http-ip`);
        expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { status: 200, body: { ok: true, path: "/ok" } } } });
        await context.settings.set("workflows.http_allowed_hosts", ["localhost"]);
        const byName = await run(`${PREFIX}-http-name`);
        expect(byName.json().data, byName.body).toMatchObject({ status: "SUCCEEDED", result: { data: { status: 200 } } });
      } finally {
        await context.settings.reset("workflows.http_allowed_hosts");
      }
    });

    it("re-checks every redirect hop: an allowed host cannot redirect to a refused address", async () => {
      await context.settings.set("workflows.http_allowed_hosts", ["localhost"]);
      try {
        const res = await run(`${PREFIX}-http-redirect`);
        expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_HTTP_DESTINATION_BLOCKED" } });
      } finally {
        await context.settings.reset("workflows.http_allowed_hosts");
      }
    });

    it("rejects an invalid allowed-hosts entry when the setting is saved", async () => {
      await expect(context.settings.set("workflows.http_allowed_hosts", ["not a host/99"])).rejects.toMatchObject({ code: "INVALID_SETTING" });
    });
  });

  describe("HTTP request: secret headers, size limits, methods, diagnostics", () => {
    const SECRET = "wfop_http_api_key";
    beforeAll(async () => {
      await context.settings.set("workflows.http_allowed_hosts", ["127.0.0.0/8"]);
      await context.secrets.set(SECRET, "s3cr3t-value");
      const step = (slug: string, configuration: Record<string, unknown>) => publishedWorkflow(`${PREFIX}-${slug}`, { type: "totalbase.http-request", configuration });
      await step("http-secret", { method: "GET", url: `http://127.0.0.1:${serverPort}/ok`, secretHeaders: [{ name: "x-api-key", secret: SECRET }] });
      await step("http-head", { method: "HEAD", url: `http://127.0.0.1:${serverPort}/ok` });
      await step("http-big", { method: "GET", url: `http://127.0.0.1:${serverPort}/big` });
      await step("http-body", { method: "POST", url: `http://127.0.0.1:${serverPort}/ok`, body: { text: "y".repeat(4096) } });
      await step("http-fail", { method: "GET", url: `http://127.0.0.1:${serverPort}/fail` });
    });
    afterAll(async () => {
      await context.settings.reset("workflows.http_allowed_hosts");
      await context.settings.reset("workflows.http_max_request_bytes");
      await context.settings.reset("workflows.http_max_response_bytes");
      await context.secrets.delete(SECRET);
    });

    it("sends a secret header's value, read at run time - never in the stored definition", async () => {
      const res = await run(`${PREFIX}-http-secret`);
      expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { body: { key: "s3cr3t-value" } } } });
      const { rows } = await database.query<{ definition: unknown }>(`SELECT definition FROM totalbase.workflows WHERE slug = $1`, [`${PREFIX}-http-secret`]);
      expect(JSON.stringify(rows[0]!.definition)).not.toContain("s3cr3t-value");
    });

    it("takes HEAD, answering its status and how long it took", async () => {
      const res = await run(`${PREFIX}-http-head`);
      expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { status: 200 } } });
      expect(typeof res.json().data.result.data.durationMs).toBe("number");
    });

    it("bounds the response and the request body", async () => {
      await context.settings.set("workflows.http_max_response_bytes", 1024);
      await context.settings.set("workflows.http_max_request_bytes", 1024);
      expect((await run(`${PREFIX}-http-big`)).json().data).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_LIMIT_EXCEEDED" } });
      expect((await run(`${PREFIX}-http-body`)).json().data).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_LIMIT_EXCEEDED" } });
    });

    it("says what failed on a non-2xx: status, url and duration - no header values", async () => {
      const res = await run(`${PREFIX}-http-fail`);
      expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "INTERNAL_ERROR" } });
      expect(res.body).toContain("HTTP request returned status 500");
    });
  });

  describe("templates as the executor", () => {
    let mailingId: string;
    let otherMailingId: string;
    let pdfId: string;

    beforeAll(async () => {
      const mailing = (name: string) => context.templatesAdmin.create({
        name, kind: "MAILING",
        content: { subject: "Order {{order.number}}", message: "<p>Hi {{customer.name}}</p>" },
        defaultCc: ["copy@example.com"],
      });
      mailingId = (await mailing(`${PREFIX}-mail`)).id;
      otherMailingId = (await mailing(`${PREFIX}-mail-other`)).id;
      pdfId = (await context.templatesAdmin.create({
        name: `${PREFIX}-pdf`, kind: "PDF",
        content: { basePdf: { width: 210, height: 297, padding: [10, 10, 10, 10] }, schemas: [{ greeting: { type: "text", position: { x: 20, y: 20 }, width: 100, height: 20 } }] },
      })).id;
      templateIds.push(mailingId, otherMailingId, pdfId);
      // Sending is a capability (Specification_Security.md §5.2) - granted here, taken away in its own test.
      await context.capabilityPermissions.setGrant(roleId, "SEND_EMAIL", "ALLOW");

      const sendFrom = (templateId: string) => ({
        type: "totalbase.send-email",
        configuration: { to: "{{start.data.to}}", template: templateId, data: { order: { number: "{{start.data.number}}" }, customer: { name: "{{start.data.name}}" } } },
      });
      await publishedWorkflow(`${PREFIX}-mail-run`, sendFrom(mailingId));
      await publishedWorkflow(`${PREFIX}-mail-other-run`, sendFrom(otherMailingId));
      await publishedWorkflow(`${PREFIX}-pdf-run`, { type: "totalbase.generate-pdf-template", configuration: { template: pdfId, data: { greeting: "Hello" } } });
    });

    it("Send email needs the executor's SEND_EMAIL capability - any DENY wins", async () => {
      await context.capabilityPermissions.clearGrant(roleId, "SEND_EMAIL");
      sent.length = 0;
      const res = await run(`${PREFIX}-mail-run`, { to: "dest@example.com", number: "42", name: "Ana" });
      expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "EMAIL_SEND_DENIED" } });
      await context.capabilityPermissions.setGrant(roleId, "SEND_EMAIL", "DENY");
      expect((await run(`${PREFIX}-mail-run`, { to: "dest@example.com", number: "42", name: "Ana" })).json().data).toMatchObject({ error: { code: "EMAIL_SEND_DENIED" } });
      expect(sent).toHaveLength(0);
      await context.capabilityPermissions.setGrant(roleId, "SEND_EMAIL", "ALLOW");
    });

    it("Send email refuses a MAILING template the executor may not READ", async () => {
      sent.length = 0;
      const res = await run(`${PREFIX}-mail-run`, { to: "dest@example.com", number: "42", name: "Ana" });
      expect(res.json().data, res.body).toMatchObject({ status: "FAILED", error: { code: "TEMPLATE_ACCESS_DENIED" } });
      expect(sent).toHaveLength(0);
    });

    it("Send email renders the template with READ (row filter honored), escaping values in the message", async () => {
      await context.permissions.set(roleId, templatesResourceId, "READ", { effect: "ALLOW", where: { id: { _eq: mailingId } } });
      try {
        sent.length = 0;
        const res = await run(`${PREFIX}-mail-run`, { to: "dest@example.com", number: "42", name: "<Ana>" });
        expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { to: "dest@example.com", subject: "Order 42" } } });
        expect(sent).toEqual([expect.objectContaining({ to: "dest@example.com", subject: "Order 42", html: "<p>Hi &lt;Ana&gt;</p>", cc: "copy@example.com" })]);

        const filtered = await run(`${PREFIX}-mail-other-run`, { to: "dest@example.com", number: "42", name: "Ana" });
        expect(filtered.json().data).toMatchObject({ status: "FAILED", error: { code: "TEMPLATE_ACCESS_DENIED" } });

        const missing = await run(`${PREFIX}-mail-run`, { to: "dest@example.com", number: "42" });
        expect(missing.json().data, missing.body).toMatchObject({ status: "FAILED", error: { code: "MISSING_TEMPLATE_VARIABLES" } });
      } finally {
        await context.permissions.delete(roleId, templatesResourceId, "READ");
      }
    });

    it("Send email attaches Files by id, each needing the executor's READ - names only in the result", async () => {
      const filesResourceId = (await database.query<{ id: string }>(
        `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'files'`,
      )).rows[0]!.id;
      const file = await context.filesAdmin.upload({ content: Buffer.from("a,b\n1,2\n"), filename: "report.csv", declaredContentType: "text/csv", visibility: "PRIVATE" });
      await publishedWorkflow(`${PREFIX}-mail-attach`, {
        type: "totalbase.send-email",
        configuration: { to: "dest@example.com", subject: "Report", bodyType: "text", textBody: "Attached.", attachments: ["{{start.data.file}}"] },
      });
      try {
        sent.length = 0;
        const denied = await run(`${PREFIX}-mail-attach`, { file: file.id });
        expect(denied.json().data, denied.body).toMatchObject({ status: "FAILED", error: { code: "FILE_ACCESS_DENIED" } });
        expect(sent).toHaveLength(0);

        await context.permissions.set(roleId, filesResourceId, "READ", { effect: "ALLOW" });
        const res = await run(`${PREFIX}-mail-attach`, { file: file.id });
        expect(res.json().data, res.body).toMatchObject({ status: "SUCCEEDED", result: { data: { to: "dest@example.com", attachments: ["report.csv"] } } });
        expect(sent).toHaveLength(1);
        expect(sent[0]!.attachments).toEqual([{ filename: "report.csv", contentType: "text/csv", content: Buffer.from("a,b\n1,2\n") }]);

        const notAnId = await run(`${PREFIX}-mail-attach`, { file: "/etc/passwd" });
        expect(notAnId.json().data).toMatchObject({ status: "FAILED", error: { code: "WORKFLOW_INVALID_DESIGN" } });
      } finally {
        await context.permissions.delete(roleId, filesResourceId, "READ");
        await context.filesAdmin.remove(file.id);
      }
    });

    it("Generate PDF from template needs READ on the template", async () => {
      const denied = await run(`${PREFIX}-pdf-run`);
      expect(denied.json().data, denied.body).toMatchObject({ status: "FAILED", error: { code: "TEMPLATE_ACCESS_DENIED" } });

      await context.permissions.set(roleId, templatesResourceId, "READ", { effect: "ALLOW", where: { id: { _eq: pdfId } } });
      try {
        const allowed = await run(`${PREFIX}-pdf-run`);
        expect(allowed.json().data, allowed.body).toMatchObject({ status: "SUCCEEDED", result: { data: { mimeType: "application/pdf" } } });
      } finally {
        await context.permissions.delete(roleId, templatesResourceId, "READ");
      }
    });
  });
});
