import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Database } from "@totalbase/database";
import { REALTIME_PUBLICATION } from "@totalbase/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";
import { syncCatalog } from "./catalog-refresh.js";
import { buildServer } from "./server.js";
import { request as httpRequest } from "node:http";

/**
 * Realtime subscriptions (Data_API.md §16), end to end on real logical replication: the REALTIME exposure and
 * its publication, the WebSocket's authentication, a subscription authorized as an intent, and every change
 * read again with the subscriber's permissions - a row filter's rows only, a delete's key, summaries.
 */
type Message = { type: string; uid?: string; event?: string; data?: unknown; errors?: { code: string }[] };

class Client {
  readonly messages: Message[] = [];
  closed = false;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => this.messages.push(JSON.parse(raw.toString()) as Message));
    socket.on("close", () => (this.closed = true));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The first message from `from` on that matches. */
  async next(match: (message: Message) => boolean, from = 0, timeoutMs = 10_000): Promise<Message> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.slice(from).find(match);
      if (found) return found;
      if (Date.now() - started > timeoutMs) throw new Error(`no matching message; got ${JSON.stringify(this.messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async subscribe(uid: string, data: Record<string, unknown>): Promise<Message> {
    const from = this.messages.length;
    this.send({ type: "subscribe", uid, data });
    return this.next((m) => m.uid === uid && (m.event === "init" || m.type === "error"), from);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("realtime subscriptions (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let clientsId: string;
  let plainId: string;
  let roleId: string;
  let key: string;
  let maxLimit: number;
  const userIds: string[] = [];
  const sockets: WebSocket[] = [];

  const CLIENTS = "realtime_test_clients";
  const PLAIN = "realtime_test_plain";
  const RESOURCE = `public.${CLIENTS}`;

  async function connect(headers: Record<string, string> = { authorization: `Bearer ${key}` }): Promise<Client> {
    const socket = await app.injectWS("/api/realtime", { headers });
    sockets.push(socket);
    return new Client(socket);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    maxLimit = await context.settings.get("api.max_limit");
    await context.settings.set("realtime.enabled", true);
    await database.query(`DROP TABLE IF EXISTS public.${CLIENTS}, public.${PLAIN} CASCADE`);
    await database.query(`CREATE TABLE public.${CLIENTS} (id serial PRIMARY KEY, city text NOT NULL, name text NOT NULL, document text)`);
    await database.query(`CREATE TABLE public.${PLAIN} (code text, label text)`);
    const register = async (name: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${name}`, name, ["GET", "POST", "PATCH", "DELETE"]],
    )).rows[0]!.id;
    clientsId = await register(CLIENTS);
    plainId = await register(PLAIN);

    roleId = (await context.roles.create("realtime-test-role", { apiAccess: true })).id;
    // Salta's clients only, and never their document.
    await context.permissions.set(roleId, clientsId, "READ", {
      effect: "ALLOW",
      where: { city: { _eq: "Salta" } },
      fields: ["id", "city", "name"].map((field) => ({ field, effect: "ALLOW" as const })),
    });
    const caller = await createTestApiToken(context, { name: "realtime-test", roleId, email: "realtime-test@example.com" });
    key = caller.plainKey;
    userIds.push(caller.userId);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await context.settings.set("api.max_limit", maxLimit);
    await context.settings.set("realtime.enabled", false);
    await context.settings.set("realtime.max_subscriptions", 50);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = ANY($1::uuid[])`, [[clientsId, plainId]]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [[clientsId, plainId]]);
    await database.query(`DROP TABLE IF EXISTS public.${CLIENTS}, public.${PLAIN} CASCADE`);
    await app.close();
    await database.close();
  });

  const published = async () => (await database.query<{ table: string }>(
    `SELECT prrelid::regclass::text AS table FROM pg_publication_rel r JOIN pg_publication p ON p.oid = r.prpubid WHERE p.pubname = $1`,
    [REALTIME_PUBLICATION],
  )).rows.map((row) => row.table);

  describe("the REALTIME exposure", () => {
    it("needs GET and a single-column primary key", async () => {
      await expect(context.resourcesAdmin.update(clientsId, { exposedMethods: ["POST", "REALTIME"] })).rejects.toMatchObject({ code: "INVALID_QUERY" });
      await expect(context.resourcesAdmin.update(plainId, { exposedMethods: ["GET", "REALTIME"] })).rejects.toMatchObject({ code: "INVALID_QUERY" });
      expect(await published()).not.toContain(PLAIN);
    });

    it("loses REALTIME, and its place in the publication, when its primary key is dropped outside TotalBase", async () => {
      const KEYED = "realtime_test_keyed";
      await database.query(`DROP TABLE IF EXISTS public.${KEYED}`);
      await database.query(`CREATE TABLE public.${KEYED} (id int PRIMARY KEY)`);
      await syncCatalog(context);
      const { rows } = await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE postgres_oid = to_regclass($1)::oid`, [`public.${KEYED}`]);
      const keyedId = rows[0]!.id;
      try {
        await context.resourcesAdmin.update(keyedId, { exposedMethods: ["GET", "REALTIME"] });
        expect(await published()).toContain(KEYED);
        await database.query(`ALTER TABLE public.${KEYED} DROP CONSTRAINT ${KEYED}_pkey`);
        await syncCatalog(context);
        expect((await context.resourcesAdmin.get(keyedId)).exposedMethods).toEqual(["GET"]);
        expect(await published()).not.toContain(KEYED);
      } finally {
        await database.query(`DROP TABLE IF EXISTS public.${KEYED}`);
        await syncCatalog(context);
      }
    });

    it("puts the table in the publication, and takes it out with the exposure", async () => {
      await context.resourcesAdmin.update(clientsId, { exposedMethods: ["GET", "REALTIME"] });
      expect(await published()).toContain(CLIENTS);
      await context.resourcesAdmin.update(clientsId, { exposedMethods: ["GET"] });
      expect(await published()).not.toContain(CLIENTS);
      await context.resourcesAdmin.update(clientsId, { exposedMethods: ["GET", "POST", "PATCH", "DELETE", "REALTIME"] });
      expect(await published()).toContain(CLIENTS);
    });
  });

  describe("connecting", () => {
    it("is refused while Realtime is off", async () => {
      await context.settings.set("realtime.enabled", false);
      try {
        await expect(connect()).rejects.toThrow(/403/);
      } finally {
        await context.settings.set("realtime.enabled", true);
      }
    });

    it("refuses a bad credential at the upgrade", async () => {
      await expect(connect({ authorization: "Bearer tb_not-a-token" })).rejects.toThrow(/401/);
    });

    it("takes the session cookie only from this instance's own pages", async () => {
      const { token } = await context.auth.sessions.create({ user: userIds[0]!, ttlHours: 1, maxSessionsPerUser: 10 });
      const own = new URL(await context.auth.mailer.publicUrl()).origin;
      await expect(connect({ cookie: `tb_session=${token}`, origin: "https://another-site.example.com" })).rejects.toThrow(/403/);
      const browser = await connect({ cookie: `tb_session=${token}`, origin: own });
      expect(await browser.subscribe("cookie", { resource: RESOURCE })).toMatchObject({ event: "init" });
    });

    it("without a credential, the first message authenticates; nothing else is accepted before it", async () => {
      const anonymous = await connect({});
      anonymous.send({ type: "subscribe", uid: "x", data: { resource: RESOURCE } });
      await anonymous.next((m) => m.type === "error" && m.errors?.[0]?.code === "AUTHENTICATION_REQUIRED");
      await sleep(50);
      expect(anonymous.closed).toBe(true);

      const late = await connect({});
      late.send({ type: "auth", data: { accessToken: key } });
      await late.next((m) => m.type === "auth");
      expect(await late.subscribe("ok", { resource: RESOURCE })).toMatchObject({ event: "init" });
    });
  });

  describe("a subscription is an intent, authorized before it exists", () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect();
    });

    it("refuses a field the subscriber may not read", async () => {
      const answer = await client.subscribe("document", { resource: RESOURCE, query: { fields: "id,document" } });
      expect(answer.errors?.[0]?.code).toBe("FIELD_PERMISSION_DENIED");
    });

    it("refuses a filter on a field the subscriber may not read", async () => {
      const answer = await client.subscribe("by-document", { resource: RESOURCE, query: { where: { document: { _eq: "1" } } } });
      expect(answer.errors?.[0]?.code).toBe("FIELD_PERMISSION_DENIED");
    });

    it("answers 404 for a table not exposing REALTIME", async () => {
      const answer = await client.subscribe("plain", { resource: `public.${PLAIN}` });
      expect(answer.errors?.[0]?.code).toBe("RESOURCE_NOT_FOUND");
    });

    it("takes no query in summary mode, and only fields and where in rows mode", async () => {
      expect((await client.subscribe("s", { resource: RESOURCE, mode: "summary", query: { fields: "id" } })).errors?.[0]?.code).toBe("INVALID_REALTIME_MESSAGE");
      expect((await client.subscribe("o", { resource: RESOURCE, query: { order_by: "id" } })).errors?.[0]?.code).toBe("INVALID_QUERY");
    });

    it("holds at most realtime.max_subscriptions on one connection", async () => {
      await context.settings.set("realtime.max_subscriptions", 1);
      try {
        const one = await connect();
        expect((await one.subscribe("a", { resource: RESOURCE })).event).toBe("init");
        expect((await one.subscribe("b", { resource: RESOURCE })).errors?.[0]?.code).toBe("TOO_MANY_SUBSCRIPTIONS");
      } finally {
        await context.settings.set("realtime.max_subscriptions", 50);
      }
    });
  });

  describe("events", () => {
    let client: Client;
    beforeAll(async () => {
      client = await connect();
      expect((await client.subscribe("rows", { resource: RESOURCE, query: { fields: "id,name" } })).event).toBe("init");
      expect((await client.subscribe("summary", { resource: RESOURCE, mode: "summary" })).event).toBe("init");
      expect((await client.subscribe("deletes", { resource: RESOURCE, event: "delete" })).event).toBe("init");
    });

    it("sends the rows the subscriber may read - Salta's, never Tartagal's - whoever wrote them", async () => {
      const from = client.messages.length;
      await database.query(`INSERT INTO public.${CLIENTS} (id, city, name, document) VALUES (1, 'Tartagal', 'Hidden', 'D1')`);
      await database.query(`INSERT INTO public.${CLIENTS} (id, city, name, document) VALUES (2, 'Salta', 'Visible', 'D2')`);
      const created = await client.next((m) => m.uid === "rows" && m.event === "create", from);
      expect(created.data).toEqual([{ id: 2, name: "Visible" }]);
      await client.next((m) => m.uid === "summary" && m.event === "create" && m.data === undefined, from);
      await sleep(200);
      const rows = client.messages.slice(from).filter((m) => m.uid === "rows");
      expect(rows).toHaveLength(1);
    });

    it("an update is read again: a hidden row's sends nothing", async () => {
      const from = client.messages.length;
      await database.query(`UPDATE public.${CLIENTS} SET name = 'Still hidden' WHERE id = 1`);
      await database.query(`UPDATE public.${CLIENTS} SET name = 'Renamed' WHERE id = 2`);
      const updated = await client.next((m) => m.uid === "rows" && m.event === "update", from);
      expect(updated.data).toEqual([{ id: 2, name: "Renamed" }]);
      expect(client.messages.slice(from).filter((m) => m.uid === "rows" && m.event === "update")).toHaveLength(1);
    });

    it("a delete sends only the key, to every subscriber with READ - a hidden row's too", async () => {
      const from = client.messages.length;
      await database.query(`DELETE FROM public.${CLIENTS} WHERE id = 1`);
      const deleted = await client.next((m) => m.uid === "deletes" && m.event === "delete", from);
      expect(deleted.data).toEqual([{ id: 1 }]);
    });

    it("a transaction past api.max_limit rows arrives as a summary", async () => {
      await context.settings.set("api.max_limit", 3);
      try {
        const from = client.messages.length;
        await database.query(`INSERT INTO public.${CLIENTS} (id, city, name) SELECT g, 'Salta', 'bulk' FROM generate_series(100, 105) g`);
        const summary = await client.next((m) => m.uid === "rows" && m.event === "create", from);
        expect(summary.data).toBeUndefined();
      } finally {
        await context.settings.set("api.max_limit", maxLimit);
      }
    });

    it("unsubscribing stops the events", async () => {
      client.send({ type: "unsubscribe", uid: "rows" });
      await sleep(100);
      const from = client.messages.length;
      await database.query(`INSERT INTO public.${CLIENTS} (id, city, name) VALUES (300, 'Salta', 'Quiet')`);
      await client.next((m) => m.uid === "summary" && m.event === "create", from);
      expect(client.messages.slice(from).some((m) => m.uid === "rows")).toBe(false);
    });

    it("a revoked READ ends the subscription at the next event", async () => {
      const own = await connect();
      expect((await own.subscribe("revoked", { resource: RESOURCE })).event).toBe("init");
      await context.permissions.delete(roleId, clientsId, "READ");
      try {
        const from = own.messages.length;
        await database.query(`INSERT INTO public.${CLIENTS} (id, city, name) VALUES (200, 'Salta', 'After')`);
        const error = await own.next((m) => m.uid === "revoked" && m.type === "error", from);
        expect(error.errors?.[0]?.code).toBe("ACTION_DENIED");
        await sleep(200);
        expect(own.messages.slice(from).some((m) => m.type === "subscription")).toBe(false);
      } finally {
        await context.permissions.set(roleId, clientsId, "READ", {
          effect: "ALLOW",
          where: { city: { _eq: "Salta" } },
          fields: ["id", "city", "name"].map((field) => ({ field, effect: "ALLOW" as const })),
        });
      }
    });


    it("reports a truncate", async () => {
      const own = await connect();
      expect((await own.subscribe("truncate", { resource: RESOURCE, mode: "summary" })).event).toBe("init");
      const from = own.messages.length;
      await database.query(`TRUNCATE public.${CLIENTS}`);
      await own.next((m) => m.uid === "truncate" && m.event === "truncate", from);
    });

    it("a lost replication connection resets every subscription, and a new slot carries on", async () => {
      const own = await connect();
      expect((await own.subscribe("reset", { resource: RESOURCE, query: { fields: "id,name" } })).event).toBe("init");
      const from = own.messages.length;
      await database.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE application_name = 'totalbase realtime'`);
      await own.next((m) => m.uid === "reset" && m.event === "reset", from);
      await database.query(`INSERT INTO public.${CLIENTS} (id, city, name) VALUES (400, 'Salta', 'After the reset')`);
      const created = await own.next((m) => m.uid === "reset" && m.event === "create", from);
      expect(created.data).toEqual([{ id: 400, name: "After the reset" }]);
    });
  });

  describe("beside another upgrade listener (the admin's development proxy)", () => {
    it("routes /api/realtime to realtime and every other upgrade, once, to the other listener", async () => {
      const server = await buildServer(context, "silent");
      const proxied: string[] = [];
      // As admin-ui.ts's @fastify/http-proxy does for Vite's HMR socket: answers every upgrade it hears.
      server.server.on("upgrade", (request: { url?: string }, socket: { end(text: string): void }) => {
        proxied.push(request.url ?? "");
        socket.end("HTTP/1.1 418 I'm a teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      await server.listen({ host: "127.0.0.1", port: 0 });
      try {
        const { port } = server.server.address() as { port: number };
        const status = await new Promise<number>((resolve, reject) => {
          const upgrade = httpRequest({ host: "127.0.0.1", port, path: "/_nuxt/", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
          upgrade.on("response", (response) => resolve(response.statusCode ?? 0));
          upgrade.on("upgrade", () => resolve(101));
          upgrade.on("error", reject);
          upgrade.end();
        });
        expect(status).toBe(418);
        expect(proxied).toEqual(["/_nuxt/"]);

        // A real socket on the same server: the first message authenticates, the server is still up.
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`);
        const answer = await new Promise<string>((resolve, reject) => {
          socket.onopen = () => socket.send(JSON.stringify({ type: "auth", data: { accessToken: key } }));
          socket.onmessage = (event) => resolve(String(event.data));
          socket.onerror = () => reject(new Error("realtime socket failed"));
        });
        expect(JSON.parse(answer)).toEqual({ type: "auth", data: { status: "ok" } });
        socket.close();
        expect(proxied).toEqual(["/_nuxt/"]);
      } finally {
        await server.close();
      }
    });
  });
});
