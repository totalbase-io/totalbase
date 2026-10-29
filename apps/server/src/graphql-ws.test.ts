import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

type Message = { type: string; id?: string; payload?: unknown };

class Client {
  readonly messages: Message[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => this.messages.push(JSON.parse(raw.toString()) as Message));
    socket.on("close", (code: number, reason: Buffer) => (this.closed = { code, reason: reason.toString() }));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async next(match: (message: Message) => boolean, from = 0, timeoutMs = 10_000): Promise<Message> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.slice(from).find(match);
      if (found) return found;
      if (Date.now() - started > timeoutMs) throw new Error(`no matching message; got ${JSON.stringify(this.messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async waitClosed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    const started = Date.now();
    while (!this.closed) {
      if (Date.now() - started > timeoutMs) throw new Error("not closed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closed;
  }
}

/**
 * GraphQL over a WebSocket (Data_API.md §17.7): the graphql-transport-ws protocol at /api/graphql -
 * the handshake, queries and mutations as over HTTP, and a subscription authorized as a read before it exists.
 * What a subscription delivers is realtime's (realtime.test.ts); here its GraphQL shape.
 */
describe("GraphQL over a WebSocket", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let key: string;
  let userId: string;
  let itemsId: string;
  const sockets: WebSocket[] = [];
  const ITEMS = "graphql_ws_test_items";

  async function connect(headers: Record<string, string> = {}, protocol = "graphql-transport-ws"): Promise<Client> {
    const socket = await app.injectWS("/api/graphql", { headers: { "sec-websocket-protocol": protocol, ...headers } });
    sockets.push(socket);
    return new Client(socket);
  }

  async function ready(): Promise<Client> {
    const client = await connect();
    client.send({ type: "connection_init", payload: { authorization: `Bearer ${key}` } });
    await client.next((m) => m.type === "connection_ack");
    return client;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text NOT NULL, secret text)`);
    await database.query(`INSERT INTO public.${ITEMS} (name, secret) VALUES ('first', 's')`);
    itemsId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET", "POST"]],
    )).rows[0]!.id;
    // Through the exposure, which puts the table in the realtime publication (Data_API.md §16.2).
    await context.resourcesAdmin.update(itemsId, { exposedMethods: ["GET", "POST", "REALTIME"] });
    roleId = (await context.roles.create(`graphql-ws-test-${uniqueSuffix()}`, { apiAccess: true })).id;
    const allow = (fields: string[]) => fields.map((field) => ({ field, effect: "ALLOW" as const }));
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", fields: allow(["id", "name"]) });
    await context.permissions.set(roleId, itemsId, "CREATE", { effect: "ALLOW", fields: allow(["name"]) });
    ({ plainKey: key, userId } = await createTestApiToken(context, { name: "graphql-ws-test", roleId, email: `graphql-ws-${uniqueSuffix()}@example.com` }));
    await context.settings.set("graphql.enabled", true);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await context.settings.set("graphql.enabled", false);
    await context.settings.set("realtime.enabled", false);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.outbox WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("speaks graphql-transport-ws only, and acknowledges a connection_init that carries a credential", async () => {
    expect((await (await connect({}, "graphql-ws")).waitClosed()).code).toBe(4406);

    const anonymous = await connect();
    anonymous.send({ type: "connection_init" });
    expect((await anonymous.waitClosed()).code).toBe(4403);

    const early = await connect();
    early.send({ type: "subscribe", id: "1", payload: { query: "{ __typename }" } });
    expect((await early.waitClosed()).code).toBe(4401);

    // The bearer header at the upgrade is enough: connection_init then needs no payload.
    const withHeader = await connect({ authorization: `Bearer ${key}` });
    withHeader.send({ type: "connection_init" });
    await withHeader.next((m) => m.type === "connection_ack");
    withHeader.send({ type: "connection_init" });
    expect((await withHeader.waitClosed()).code).toBe(4429);
  });

  it("runs a query and a mutation as over HTTP: next, then complete", async () => {
    const client = await ready();
    client.send({ type: "subscribe", id: "q", payload: { query: `{ ${ITEMS} { name } }` } });
    expect(await client.next((m) => m.id === "q" && m.type === "next")).toMatchObject({ payload: { data: { [ITEMS]: [{ name: "first" }] } } });
    await client.next((m) => m.id === "q" && m.type === "complete");

    client.send({ type: "subscribe", id: "m", payload: { query: `mutation { ${ITEMS}_insert_one(data: { name: "second" }) { name } }` } });
    expect(await client.next((m) => m.id === "m" && m.type === "next")).toMatchObject({ payload: { data: { [`${ITEMS}_insert_one`]: { name: "second" } } } });

    // A request that doesn't validate is an error message, and runs nothing.
    client.send({ type: "subscribe", id: "bad", payload: { query: `{ ${ITEMS} { secret } }` } });
    const error = await client.next((m) => m.id === "bad" && m.type === "error");
    expect((error.payload as { extensions: { code: string } }[])[0]!.extensions.code).toBe("INVALID_QUERY");

    client.send({ type: "ping" });
    await client.next((m) => m.type === "pong");
  });

  it("lists a Subscription for the tables exposing REALTIME only while realtime is on, and over HTTP refuses it", async () => {
    const http = (query: string) => app.inject({ method: "POST", url: "/api/graphql", headers: { authorization: `Bearer ${key}` }, payload: { query } });
    const fieldsOf = async () => (await http("{ __schema { subscriptionType { fields { name } } } }")).json().data.__schema.subscriptionType?.fields.map((f: { name: string }) => f.name);

    await context.settings.set("realtime.enabled", false);
    expect(await fieldsOf()).toBeUndefined();
    await context.settings.set("realtime.enabled", true);
    expect(await fieldsOf()).toEqual([ITEMS]);

    const overHttp = await http(`subscription { ${ITEMS} { event } }`);
    expect(overHttp.statusCode).toBe(400);
    expect(overHttp.json().errors[0].message).toContain("WebSocket");
  });

  it("delivers each change as the subscriber may read it: rows on create and update, keys on delete, nothing read for a summary", async () => {
    await context.settings.set("realtime.enabled", true);
    const client = await ready();
    client.send({ type: "subscribe", id: "rows", payload: { query: `subscription { ${ITEMS} { event rows { id name } keys } }` } });
    client.send({ type: "subscribe", id: "summary", payload: { query: `subscription { ${ITEMS}(events: [UPDATE]) { event } }` } });
    const event = (id: string, name: string) => client.next((m) => m.id === id && (m.payload as { data?: Record<string, { event: string }> })?.data?.[ITEMS]?.event === name, 0, 20_000);
    await event("rows", "INIT");
    await event("summary", "INIT");

    const { rows } = await database.query<{ id: number }>(`INSERT INTO public.${ITEMS} (name, secret) VALUES ('live', 'hidden') RETURNING id`);
    const id = rows[0]!.id;
    expect((await event("rows", "CREATE")).payload).toEqual({ data: { [ITEMS]: { event: "CREATE", rows: [{ id, name: "live" }], keys: null } } });

    await database.query(`UPDATE public.${ITEMS} SET name = 'renamed' WHERE id = $1`, [id]);
    expect((await event("rows", "UPDATE")).payload).toMatchObject({ data: { [ITEMS]: { rows: [{ id, name: "renamed" }] } } });
    expect((await event("summary", "UPDATE")).payload).toEqual({ data: { [ITEMS]: { event: "UPDATE" } } });

    await database.query(`DELETE FROM public.${ITEMS} WHERE id = $1`, [id]);
    expect((await event("rows", "DELETE")).payload).toEqual({ data: { [ITEMS]: { event: "DELETE", rows: null, keys: [id] } } });

    // complete from the client ends it: no more messages for that id.
    client.send({ type: "complete", id: "rows" });
    client.send({ type: "complete", id: "summary" });
  }, 60_000);

  it("authorizes a subscription as a read before it exists", async () => {
    await context.settings.set("realtime.enabled", true);
    const client = await ready();
    // A field the grant leaves out isn't in the schema; a one-to-many field isn't delivered.
    client.send({ type: "subscribe", id: "s1", payload: { query: `subscription { ${ITEMS} { rows { secret } } }` } });
    expect(await client.next((m) => m.id === "s1" && m.type === "error")).toBeDefined();

    // Turned off meanwhile: a subscription the schema still lists is refused when it starts.
    await context.settings.set("realtime.enabled", false);
    const cached = await ready();
    cached.send({ type: "subscribe", id: "s2", payload: { query: `subscription { ${ITEMS} { event } }` } });
    const refused = await cached.next((m) => m.id === "s2" && m.type === "error", 0).catch(() => undefined);
    // Without realtime there is no Subscription type: validation refuses it.
    expect(refused).toBeDefined();
  });
});
