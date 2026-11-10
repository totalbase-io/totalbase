import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Database } from "@totalbase/database";
import { hashPassword } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * Realtime tickets (Security.md §2.10, Data_API.md §16.3): a session asks for a 60-second, single-use ticket; a
 * browser that never held the session token opens /api/realtime (or the graphql-transport-ws socket) with it,
 * and the connection is the session's - resolved again before every delivery, closed when the session ends.
 */
type Message = { type: string; uid?: string; event?: string; data?: unknown; errors?: { code: string }[]; payload?: unknown; id?: string };

class Client {
  readonly messages: Message[] = [];
  closed = false;
  closeCode: number | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: Buffer) => this.messages.push(JSON.parse(raw.toString()) as Message));
    socket.on("close", (code: number) => {
      this.closed = true;
      this.closeCode = code;
    });
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

  async waitClosed(timeoutMs = 10_000): Promise<number | null> {
    const started = Date.now();
    while (!this.closed) {
      if (Date.now() - started > timeoutMs) throw new Error(`still open; got ${JSON.stringify(this.messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closeCode;
  }
}

const PASSWORD = "a-strong-enough-password";

describe("Realtime tickets", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let itemsId: string;
  let sessionToken: string;
  let email: string;
  const userIds: string[] = [];
  const sockets: WebSocket[] = [];
  const ITEMS = `realtime_tickets_test_items_${uniqueSuffix()}`;

  const post = (url: string, token: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
  const ticketFor = async (token = sessionToken): Promise<string> => {
    const res = await post("/api/auth/realtime-ticket", token);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.ticket).toMatch(/^rt_/);
    expect(new Date(res.json().data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    return res.json().data.ticket as string;
  };
  async function connect(path = "/api/realtime", headers: Record<string, string> = {}): Promise<Client> {
    const socket = await app.injectWS(path, { headers });
    sockets.push(socket);
    return new Client(socket);
  }
  async function authenticated(ticket: string): Promise<Client> {
    const client = await connect();
    client.send({ type: "auth", data: { ticket } });
    await client.next((m) => m.type === "auth" || m.type === "error");
    return client;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await context.settings.set("realtime.enabled", true);
    await database.query(`CREATE TABLE public.${ITEMS} (id serial PRIMARY KEY, name text NOT NULL)`);
    itemsId = (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regclass($1)::oid, 'public', $2, 'TABLE', 'ACTIVE', $3) RETURNING id`,
      [`public.${ITEMS}`, ITEMS, ["GET"]],
    )).rows[0]!.id;
    await context.resourcesAdmin.update(itemsId, { exposedMethods: ["GET", "REALTIME"] });
    roleId = (await context.roles.create(`realtime-tickets-${uniqueSuffix()}`, { apiAccess: true })).id;
    await context.permissions.set(roleId, itemsId, "READ", { effect: "ALLOW", fields: ["id", "name"].map((field) => ({ field, effect: "ALLOW" as const })) });
    email = `realtime-tickets-${uniqueSuffix()}@example.com`;
    const user = await context.auth.users.create({ email, name: "Ticket holder", passwordHash: await hashPassword(PASSWORD), emailVerified: true });
    userIds.push(user.id);
    await context.roleAssignments.assignRoleToUser(user.id, roleId);
    sessionToken = (await context.auth.login({ email, password: PASSWORD })).token;
    await context.settings.set("graphql.enabled", true);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await context.settings.set("graphql.enabled", false);
    await context.settings.set("realtime.enabled", false);
    for (const id of userIds) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.logs WHERE resource = $1`, [itemsId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [itemsId]);
    await database.query(`DROP TABLE IF EXISTS public.${ITEMS} CASCADE`);
    await app.close();
    await database.close();
  });

  it("a ticket opens a connection bound to the session, which delivers the session's subscription; the ticket works once", async () => {
    const ticket = await ticketFor();
    const client = await authenticated(ticket);
    expect(client.messages.at(-1)).toMatchObject({ type: "auth", data: { status: "ok" } });

    const init = await (async () => {
      const from = client.messages.length;
      client.send({ type: "subscribe", uid: "items", data: { resource: `public.${ITEMS}` } });
      return client.next((m) => m.uid === "items" && (m.event === "init" || m.type === "error"), from);
    })();
    expect(init.event, JSON.stringify(init)).toBe("init");
    const from = client.messages.length;
    await database.query(`INSERT INTO public.${ITEMS} (name) VALUES ('first')`);
    const created = await client.next((m) => m.uid === "items" && m.event === "create", from);
    expect(created.data).toEqual([{ id: expect.any(Number), name: "first" }]);

    // Spent: the same ticket again is refused, and the socket closes.
    const again = await authenticated(ticket);
    expect(again.messages.at(-1)?.errors?.[0]?.code).toBe("AUTHENTICATION_REQUIRED");
    expect(await again.waitClosed()).toBe(1008);
  });

  it("an expired ticket, an unknown one and a personal token asking for one are refused", async () => {
    const ticket = await ticketFor();
    await database.query(`UPDATE totalbase.sessions_tickets SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    const expired = await authenticated(ticket);
    expect(expired.messages.at(-1)?.errors?.[0]?.code).toBe("AUTHENTICATION_REQUIRED");
    const unknown = await authenticated("rt_not-a-ticket");
    expect(unknown.messages.at(-1)?.errors?.[0]?.code).toBe("AUTHENTICATION_REQUIRED");

    const { plainKey, userId } = await createTestApiToken(context, { name: "realtime-tickets-token", roleId, email: `realtime-tickets-token-${uniqueSuffix()}@example.com` });
    userIds.push(userId);
    expect((await post("/api/auth/realtime-ticket", plainKey)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/realtime-ticket" })).statusCode).toBe(401);
  });

  it("a session revoked after the ticket closes the connection at the next delivery", async () => {
    const token = (await context.auth.login({ email, password: PASSWORD })).token;
    const client = await authenticated(await ticketFor(token));
    const from = client.messages.length;
    client.send({ type: "subscribe", uid: "items", data: { resource: `public.${ITEMS}` } });
    await client.next((m) => m.uid === "items" && m.event === "init", from);
    await context.auth.logout(token);
    await database.query(`INSERT INTO public.${ITEMS} (name) VALUES ('after sign-out')`);
    expect(await client.waitClosed()).toBe(1008);
    expect(client.messages.at(-1)?.errors?.[0]?.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("graphql-transport-ws takes the ticket in connection_init", async () => {
    const client = await connect("/api/graphql", { "sec-websocket-protocol": "graphql-transport-ws" });
    client.send({ type: "connection_init", payload: { ticket: await ticketFor() } });
    await client.next((m) => m.type === "connection_ack");
    client.send({ type: "subscribe", id: "1", payload: { query: `{ ${ITEMS}(limit: 1) { name } }` } });
    const next = await client.next((m) => m.type === "next" && m.id === "1");
    expect((next.payload as { data: Record<string, unknown[]> }).data[ITEMS]).toHaveLength(1);

    const refused = await connect("/api/graphql", { "sec-websocket-protocol": "graphql-transport-ws" });
    refused.send({ type: "connection_init", payload: { ticket: "rt_spent-or-unknown" } });
    expect(await refused.waitClosed()).toBe(4403);
  });
});
