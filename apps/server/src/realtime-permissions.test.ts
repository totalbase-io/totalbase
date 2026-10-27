import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Realtime subscriptions under each permission shape (Data_API.md §16.4, §16.5; Security.md §6): a change reaches a
 * subscriber exactly as a GET would show it - `$USER` row filters, ALLOW filters of several roles OR-combined,
 * the subscription's own `where` AND-combined with them, a field DENY over another role's ALLOW, a filter
 * through a relation - and never another subscriber's rows.
 */
type Message = { type: string; uid?: string; event?: string; data?: Record<string, unknown>[]; errors?: { code: string }[] };

class Client {
  readonly messages: Message[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => this.messages.push(JSON.parse(raw.toString()) as Message));
  }

  async subscribe(uid: string, data: Record<string, unknown>): Promise<Message> {
    const from = this.messages.length;
    this.socket.send(JSON.stringify({ type: "subscribe", uid, data }));
    return this.next((m) => m.uid === uid && (m.event === "init" || m.type === "error"), from);
  }

  async next(match: (message: Message) => boolean, from = 0, timeoutMs = 8_000): Promise<Message> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.slice(from).find(match);
      if (found) return found;
      if (Date.now() - started > timeoutMs) throw new Error(`no matching message; got ${JSON.stringify(this.messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Every row this subscription received since `from`, by event. */
  rows(uid: string, event: string, from: number): Record<string, unknown>[] {
    return this.messages.slice(from).filter((m) => m.uid === uid && m.event === event).flatMap((m) => m.data ?? []);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("realtime subscriptions under permissions (integration)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const resourceIds: string[] = [];
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const sockets: WebSocket[] = [];

  const ORDERS = "realtime_perm_orders";
  const SITES = "realtime_perm_sites";
  const RESOURCE = `public.${ORDERS}`;

  /** One user, holding `roles` (created with these READ grants on the orders), and their connection. */
  const users: Record<string, { id: string; client: Client }> = {};
  let ordersId: string;

  async function role(name: string, grant: Parameters<AppContext["permissions"]["set"]>[3]): Promise<string> {
    const id = (await context.roles.create(`realtime-perm-${name}`, { apiAccess: true })).id;
    roleIds.push(id);
    await context.permissions.set(id, ordersId, "READ", grant);
    return id;
  }

  async function user(name: string, roles: string[]): Promise<void> {
    const caller = await createTestApiToken(context, { name: `realtime-perm-${name}`, roleId: roles[0]!, email: `realtime-perm-${name}@example.com` });
    for (const extra of roles.slice(1)) await context.roleAssignments.assignRoleToUser(caller.userId, extra);
    userIds.push(caller.userId);
    const socket = await app.injectWS("/api/realtime", { headers: { authorization: `Bearer ${caller.plainKey}` } });
    sockets.push(socket);
    users[name] = { id: caller.userId, client: new Client(socket) };
  }

  /** Inserts `rows` in one transaction, as psql would - not through the Data API. */
  async function insert(rows: string): Promise<void> {
    await database.query(`INSERT INTO public.${ORDERS} (id, city, priority, site, owner, notes) VALUES ${rows}`);
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await context.settings.set("realtime.enabled", true);
    await database.query(`DROP TABLE IF EXISTS public.${ORDERS}, public.${SITES} CASCADE`);
    await database.query(`CREATE TABLE public.${SITES} (id int PRIMARY KEY, region text NOT NULL)`);
    await database.query(
      `CREATE TABLE public.${ORDERS} (id int PRIMARY KEY, city text NOT NULL, priority text NOT NULL,
         site int REFERENCES public.${SITES} (id), owner uuid, notes text)`,
    );
    await database.query(`INSERT INTO public.${SITES} VALUES (1, 'NOA'), (2, 'Cuyo')`);
    const register = async (name: string, methods: string[]) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${name}`, name, methods],
    )).rows[0]!.id;
    resourceIds.push(await register(SITES, ["GET"]));
    ordersId = await register(ORDERS, ["GET"]);
    resourceIds.push(ordersId);
    await context.resourcesAdmin.update(ordersId, { exposedMethods: ["GET", "REALTIME"] });

    const everyField = ["id", "city", "priority", "site", "owner", "notes"].map((field) => ({ field, effect: "ALLOW" as const }));
    const salta = await role("salta", { effect: "ALLOW", where: { city: { _eq: "Salta" } }, fields: everyField });
    const jujuy = await role("jujuy", { effect: "ALLOW", where: { city: { _eq: "Jujuy" } }, fields: everyField });
    const own = await role("own", { effect: "ALLOW", where: { owner: { _eq: "$USER.id" } }, fields: everyField });
    const noa = await role("noa", { effect: "ALLOW", where: { "site.region": { _eq: "NOA" } }, fields: everyField });
    const notesAllowed = await role("notes-allowed", { effect: "ALLOW", fields: everyField });
    const notesDenied = await role("notes-denied", { effect: "ALLOW", fields: [{ field: "notes", effect: "DENY" }] });

    await user("salta", [salta]);
    await user("both", [salta, jujuy]);
    await user("own", [own]);
    await user("owner2", [own]);
    await user("noa", [noa]);
    await user("denied", [notesAllowed, notesDenied]);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await context.settings.set("realtime.enabled", false);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = ANY($1::uuid[])`, [roleIds]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = ANY($1::uuid[])`, [resourceIds]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [resourceIds]);
    await database.query(`DROP TABLE IF EXISTS public.${ORDERS}, public.${SITES} CASCADE`);
    await app.close();
    await database.close();
  });

  it("a $USER row filter: each owner receives only their own rows, never the other's", async () => {
    const own = users.own!.client;
    const other = users.owner2!.client;
    expect((await own.subscribe("mine", { resource: RESOURCE, query: { fields: "id,owner" } })).event).toBe("init");
    expect((await other.subscribe("mine", { resource: RESOURCE, query: { fields: "id,owner" } })).event).toBe("init");
    const [fromOwn, fromOther] = [own.messages.length, other.messages.length];
    await insert(`(1, 'Salta', 'LOW', 1, '${users.own!.id}', null), (2, 'Salta', 'LOW', 1, '${users.owner2!.id}', null), (3, 'Salta', 'LOW', 1, null, null)`);
    await own.next((m) => m.uid === "mine" && m.event === "create", fromOwn);
    await other.next((m) => m.uid === "mine" && m.event === "create", fromOther);
    await sleep(200);
    expect(own.rows("mine", "create", fromOwn)).toEqual([{ id: 1, owner: users.own!.id }]);
    expect(other.rows("mine", "create", fromOther)).toEqual([{ id: 2, owner: users.owner2!.id }]);
  });

  it("two roles' ALLOW filters combine with OR: Salta's and Jujuy's, not Tucumán's", async () => {
    const both = users.both!.client;
    expect((await both.subscribe("north", { resource: RESOURCE, query: { fields: "id,city" } })).event).toBe("init");
    const from = both.messages.length;
    await insert(`(10, 'Salta', 'LOW', 1, null, null), (11, 'Jujuy', 'LOW', 1, null, null), (12, 'Tucumán', 'LOW', 1, null, null)`);
    await both.next((m) => m.uid === "north" && m.event === "create", from);
    await sleep(200);
    expect(both.rows("north", "create", from)).toEqual([{ id: 10, city: "Salta" }, { id: 11, city: "Jujuy" }]);
  });

  it("the subscription's own where AND-combines with the row filter: Salta's HIGH orders only", async () => {
    const salta = users.salta!.client;
    expect((await salta.subscribe("high", { resource: RESOURCE, query: { fields: "id,city,priority", where: { priority: { _eq: "HIGH" } } } })).event).toBe("init");
    const from = salta.messages.length;
    await insert(`(20, 'Salta', 'HIGH', 1, null, null), (21, 'Salta', 'LOW', 1, null, null), (22, 'Jujuy', 'HIGH', 1, null, null)`);
    await salta.next((m) => m.uid === "high" && m.event === "create", from);
    await sleep(200);
    expect(salta.rows("high", "create", from)).toEqual([{ id: 20, city: "Salta", priority: "HIGH" }]);

    // An update that moves a Jujuy order to HIGH reaches no one here; one that moves a Salta order does.
    const next = salta.messages.length;
    await database.query(`UPDATE public.${ORDERS} SET priority = 'HIGH' WHERE id IN (21, 11)`);
    await salta.next((m) => m.uid === "high" && m.event === "update", next);
    await sleep(200);
    expect(salta.rows("high", "update", next)).toEqual([{ id: 21, city: "Salta", priority: "HIGH" }]);
  });

  it("a field DENY of one role wins over another's ALLOW: refused when asked, left out otherwise", async () => {
    const denied = users.denied!.client;
    expect((await denied.subscribe("notes", { resource: RESOURCE, query: { fields: "id,notes" } })).errors?.[0]?.code).toBe("FIELD_PERMISSION_DENIED");
    expect((await denied.subscribe("by-notes", { resource: RESOURCE, query: { where: { notes: { _eq: "secret" } } } })).errors?.[0]?.code).toBe("FIELD_PERMISSION_DENIED");
    expect((await denied.subscribe("all", { resource: RESOURCE })).event).toBe("init");
    const from = denied.messages.length;
    await insert(`(30, 'Salta', 'LOW', 1, null, 'secret')`);
    const created = await denied.next((m) => m.uid === "all" && m.event === "create", from);
    expect(created.data).toHaveLength(1);
    expect(created.data![0]).toMatchObject({ id: 30, city: "Salta" });
    expect(created.data![0]).not.toHaveProperty("notes");
  });

  it("a row filter through a relation: NOA's sites only", async () => {
    const noa = users.noa!.client;
    expect((await noa.subscribe("region", { resource: RESOURCE, query: { fields: "id,site" } })).event).toBe("init");
    const from = noa.messages.length;
    await insert(`(40, 'Salta', 'LOW', 1, null, null), (41, 'Mendoza', 'LOW', 2, null, null)`);
    await noa.next((m) => m.uid === "region" && m.event === "create", from);
    await sleep(200);
    expect(noa.rows("region", "create", from)).toEqual([{ id: 40, site: 1 }]);

    // A site that moves out of NOA takes its orders out of the next re-read.
    const next = noa.messages.length;
    await database.query(`UPDATE public.${SITES} SET region = 'Cuyo' WHERE id = 1`);
    await database.query(`UPDATE public.${ORDERS} SET priority = 'HIGH' WHERE id = 40`);
    await sleep(500);
    expect(noa.rows("region", "update", next)).toEqual([]);
    await database.query(`UPDATE public.${SITES} SET region = 'NOA' WHERE id = 1`);
  });

  it("one transaction, several subscribers: each receives only what their own permissions show", async () => {
    const salta = users.salta!.client;
    const both = users.both!.client;
    const own = users.own!.client;
    expect((await salta.subscribe("mixed", { resource: RESOURCE, query: { fields: "id" } })).event).toBe("init");
    expect((await both.subscribe("mixed", { resource: RESOURCE, query: { fields: "id" } })).event).toBe("init");
    expect((await own.subscribe("mixed", { resource: RESOURCE, query: { fields: "id" } })).event).toBe("init");
    const [a, b, c] = [salta.messages.length, both.messages.length, own.messages.length];
    await insert(`(50, 'Salta', 'LOW', 2, null, null), (51, 'Jujuy', 'LOW', 2, null, null), (52, 'Tucumán', 'LOW', 2, '${users.own!.id}', null)`);
    await salta.next((m) => m.uid === "mixed" && m.event === "create", a);
    await both.next((m) => m.uid === "mixed" && m.event === "create", b);
    await own.next((m) => m.uid === "mixed" && m.event === "create", c);
    await sleep(200);
    expect(salta.rows("mixed", "create", a)).toEqual([{ id: 50 }]);
    expect(both.rows("mixed", "create", b)).toEqual([{ id: 50 }, { id: 51 }]);
    expect(own.rows("mixed", "create", c)).toEqual([{ id: 52 }]);
  });
});
