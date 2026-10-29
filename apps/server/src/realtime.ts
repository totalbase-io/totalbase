import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket, { type WebSocket } from "@fastify/websocket";
import { TotalBaseError } from "@totalbase/errors";
import type { RelationChanges, ReplicatedTransaction } from "@totalbase/database";
import { REALTIME_PUBLICATION, resolveTableResource, resolveTableResourceById, type ResolvedApiResource } from "@totalbase/resources";
import type { AppContext } from "./context.js";
import { extractBearerToken, requireAdmin } from "./auth-guards.js";
import { adminDoc, object, ok } from "./openapi-admin-docs.js";
import { resolveDataPrincipal, type DataPrincipal } from "./data-principal.js";
import { authorizeRows, readRows } from "./data-read.js";
import type { ReadOrigin } from "./read-audit.js";
import { isSameOrigin } from "./session-cookie.js";

/**
 * Realtime subscriptions (Data_API.md §16): one WebSocket at /api/realtime, subscriptions to the tables
 * exposing REALTIME, fed by this process's logical replication slot (@totalbase/database's replicate). A
 * subscription is authorized as a read before it exists; each changed row is read again with the
 * subscriber's permissions (data-read.ts), so PostgreSQL decides what reaches whom.
 */

const AUTH_TIMEOUT_MS = 10_000;
/** Past this much unsent on a socket, the client isn't reading: it is closed, never buffered without bound (Data_API.md §16.7). */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Transactions waiting for delivery; past it the process is behind - every subscription is reset instead. */
const MAX_PENDING_TRANSACTIONS = 1_000;
/** Re-reads at a time: a bulk write never takes the pooled connections the API's own requests need. */
const DELIVERY_CONCURRENCY = 4;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_UID_LENGTH = 64;

/** A close for a refused credential or permission, and one for a client that should come back later. */
const CLOSE_POLICY = 1008;
const CLOSE_TRY_LATER = 1013;

export type RealtimeEvent = "create" | "update" | "delete";
/** What a subscriber hears: the accepted subscription, a change, or that changes may have been missed (Data_API.md §16.5, §16.6). */
export type RealtimeDelivery = "init" | RealtimeEvent | "truncate" | "reset";
const EVENTS: RealtimeEvent[] = ["create", "update", "delete"];
const CHANGE_OF: Record<RealtimeEvent, "insert" | "update" | "delete"> = { create: "insert", update: "update", delete: "delete" };

/**
 * Who a subscription delivers to: a /api/realtime connection, or a GraphQL subscription (routes/graphql-ws.ts).
 * The hub decides what reaches it; the subscriber only says it in its own protocol.
 */
export interface RealtimeSubscriber {
  readonly closed: boolean;
  /** The credential, resolved again before each delivery (Data_API.md §16.3). */
  readonly token: string | null;
  /** A READ audit row's origin, a request id of its own per delivery. */
  origin(): ReadOrigin;
  event(uid: string, event: RealtimeDelivery, data?: Record<string, unknown>[]): void;
  /** A delivery's error that leaves the subscription on. */
  failed(uid: string, error: unknown): void;
  /** The subscription no longer passes its intent: the hub has dropped it. */
  ended(uid: string, error: unknown): void;
  /** The credential no longer resolves: the connection closes. */
  refused(error: unknown): void;
}

export interface Subscription {
  uid: string;
  subscriber: RealtimeSubscriber;
  resource: ResolvedApiResource;
  keyColumn: string;
  /** int2/int4 keys go out as numbers, like the Data API's rows; every other key as text. */
  keyIsNumber: boolean;
  events: ReadonlySet<RealtimeEvent>;
  mode: "rows" | "summary";
  query: { fields?: unknown; where?: unknown };
}

function errorBody(error: unknown): { code: string; message: string } {
  if (error instanceof TotalBaseError) {
    const [first] = error.toPublicErrors();
    return { code: String(first?.code ?? error.code), message: String(first?.message ?? error.message) };
  }
  return { code: "INTERNAL_ERROR", message: "Internal server error." };
}

class Connection implements RealtimeSubscriber {
  readonly subscriptions = new Map<string, Subscription>();
  token: string | null;
  awaitingPong = false;
  closed = false;
  private nextUid = 1;

  constructor(
    readonly socket: WebSocket,
    token: string | null,
    private readonly request: FastifyRequest,
  ) {
    this.token = token;
  }

  /** A READ audit row's origin: the upgrade's IP and user agent, a request id of its own per delivery (Data_API.md §16.5). */
  origin(): ReadOrigin {
    return { requestId: randomUUID(), ip: this.request.ip, userAgent: this.request.headers["user-agent"] };
  }

  generatedUid(): string {
    while (this.subscriptions.has(String(this.nextUid))) this.nextUid += 1;
    return String(this.nextUid++);
  }

  send(message: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(CLOSE_TRY_LATER, new TotalBaseError("REALTIME_CLIENT_TOO_SLOW", "The connection fell too far behind reading its messages."));
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  error(error: unknown, uid?: string): void {
    this.send({ type: "error", ...(uid !== undefined && { uid }), errors: [errorBody(error)] });
  }

  event(uid: string, event: RealtimeDelivery, data?: Record<string, unknown>[]): void {
    this.send({ type: "subscription", uid, event, ...(data !== undefined && { data }) });
  }

  failed(uid: string, error: unknown): void {
    this.error(error, uid);
  }

  ended(uid: string, error: unknown): void {
    this.subscriptions.delete(uid);
    this.error(error, uid);
  }

  refused(error: unknown): void {
    this.close(CLOSE_POLICY, error);
  }

  /** An error about the connection, then the close (Data_API.md §16.6). */
  close(code: number, error?: unknown): void {
    if (this.closed) return;
    if (error !== undefined && this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify({ type: "error", errors: [errorBody(error)] }));
    }
    this.closed = true;
    this.socket.close(code);
  }
}

/** This process's subscriptions by table OID, and the replication slot that feeds them while any exists. */
export class RealtimeHub {
  private readonly byTable = new Map<number, Set<Subscription>>();
  private count = 0;
  private replication: { close(): Promise<void> } | null = null;
  /** Starting and stopping the slot, one after the other. */
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly pending: ReplicatedTransaction[] = [];
  private draining = false;
  private maxKeys = 500;

  constructor(private readonly context: AppContext) {}

  /** Adds a subscription, starting the slot with the process's first; a slot that can't start is REALTIME_UNAVAILABLE. */
  async add(subscription: Subscription): Promise<void> {
    this.maxKeys = await this.context.settings.get("api.max_limit");
    const started = (this.lifecycle = this.lifecycle.catch(() => undefined).then(() => this.start()));
    await started;
    const oid = subscription.resource.postgresOid;
    let set = this.byTable.get(oid);
    if (!set) this.byTable.set(oid, (set = new Set()));
    set.add(subscription);
    this.count += 1;
  }

  remove(subscription: Subscription): void {
    const set = this.byTable.get(subscription.resource.postgresOid);
    if (!set?.delete(subscription)) return;
    if (set.size === 0) this.byTable.delete(subscription.resource.postgresOid);
    this.count -= 1;
    if (this.count === 0) this.lifecycle = this.lifecycle.catch(() => undefined).then(() => this.stopIfIdle());
  }

  async close(): Promise<void> {
    await this.lifecycle.catch(() => undefined);
    await this.replication?.close();
    this.replication = null;
  }

  private async start(): Promise<void> {
    if (this.replication) return;
    try {
      this.replication = await this.context.database.replicate(
        { publication: REALTIME_PUBLICATION, maxKeys: () => this.maxKeys },
        {
          onTransaction: (transaction) => this.enqueue(transaction),
          onReconnect: () => this.resetAll(),
          onError: (error) => this.context.logger.warn({ error }, "realtime replication connection lost"),
        },
      );
    } catch (error) {
      this.context.logger.warn({ error }, "realtime replication could not start");
      throw new TotalBaseError("REALTIME_UNAVAILABLE", "Realtime can't replicate from PostgreSQL right now (Settings > Realtime shows its requirements).");
    }
  }

  private async stopIfIdle(): Promise<void> {
    if (this.count > 0 || !this.replication) return;
    const replication = this.replication;
    this.replication = null;
    await replication.close();
  }

  private enqueue(transaction: ReplicatedTransaction): void {
    if (![...transaction.keys()].some((oid) => this.byTable.has(oid))) return;
    if (this.pending.length >= MAX_PENDING_TRANSACTIONS) {
      this.pending.length = 0;
      this.resetAll();
      return;
    }
    this.pending.push(transaction);
    void this.drain();
  }

  /** Changes may have been missed: every subscription reads again (Data_API.md §16.6). */
  private resetAll(): void {
    this.pending.length = 0;
    for (const set of this.byTable.values()) {
      for (const subscription of set) subscription.subscriber.event(subscription.uid, "reset");
    }
  }

  /** One transaction after the other, so each connection gets them in commit order. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const transaction = this.pending.shift()!;
        this.maxKeys = await this.context.settings.get("api.max_limit").catch(() => this.maxKeys);
        const principals = new Map<RealtimeSubscriber, Promise<DataPrincipal | null>>();
        const tasks: (() => Promise<void>)[] = [];
        for (const [oid, changes] of transaction) {
          for (const subscription of this.byTable.get(oid) ?? []) tasks.push(() => this.deliver(subscription, changes, principals));
        }
        await runLimited(tasks, DELIVERY_CONCURRENCY);
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(subscription: Subscription, changes: RelationChanges, principals: Map<RealtimeSubscriber, Promise<DataPrincipal | null>>): Promise<void> {
    const { subscriber, uid } = subscription;
    if (subscriber.closed) return;
    // The credential, live - once per subscriber and transaction (Data_API.md §16.3).
    let principal = principals.get(subscriber);
    if (!principal) {
      principal = resolveDataPrincipal(this.context, subscriber.token ?? "").catch((error: unknown) => {
        subscriber.refused(error);
        return null;
      });
      principals.set(subscriber, principal);
    }
    const caller = await principal;
    if (!caller) return;

    // Still subscribable, and still the intent it was allowed (Data_API.md §16.4): otherwise the subscription ends.
    try {
      subscription.resource = await resolveTableResourceById(this.context, subscription.resource.id, "REALTIME");
      await authorizeIntent(this.context, caller, subscription, subscriber.origin());
    } catch (error) {
      endSubscription(this, subscription, error);
      return;
    }

    if (changes.truncate) subscriber.event(uid, "truncate");
    for (const event of EVENTS) {
      if (!subscription.events.has(event)) continue;
      const changed = changes[CHANGE_OF[event]];
      if (!changed.overflow && changed.keys.length === 0) continue;
      // A summary: only that rows changed - chosen, or past what one read returns (Data_API.md §16.5).
      // Past the limit in force now, too: it may have been lowered after the keys were collected.
      if (subscription.mode === "summary" || changed.overflow || changed.keys.length > this.maxKeys) {
        subscriber.event(uid, event);
        continue;
      }
      if (event === "delete") {
        subscriber.event(uid, event, changed.keys.map((key) => ({ [subscription.keyColumn]: subscription.keyIsNumber ? Number(key) : key })));
        continue;
      }
      const byKey = { [subscription.keyColumn]: { _in: changed.keys } };
      const where = subscription.query.where === undefined ? byKey : { _and: [byKey, subscription.query.where] };
      try {
        const { data } = await readRows(
          this.context,
          caller,
          subscription.resource,
          { ...(subscription.query.fields !== undefined && { fields: subscription.query.fields }), where, limit: String(changed.keys.length) },
          subscriber.origin(),
        );
        if (data.length > 0) subscriber.event(uid, event, data);
      } catch (error) {
        subscriber.failed(uid, error);
      }
    }
  }
}

async function runLimited(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function endSubscription(hub: RealtimeHub, subscription: Subscription, error: unknown): void {
  hub.remove(subscription);
  subscription.subscriber.ended(subscription.uid, error);
}

export interface SubscriptionIntent {
  schema: string;
  table: string;
  events: ReadonlySet<RealtimeEvent>;
  mode: "rows" | "summary";
  query: { fields?: unknown; where?: unknown };
}

/**
 * Opens a subscription for `subscriber` (Data_API.md §16.4): the table exposing REALTIME with a single-column
 * key, the intent authorized as a read before it exists, then the hub's - starting the slot with the process's
 * first. Whoever opens it removes it (hub.remove) when it ends.
 */
export async function openSubscription(
  context: AppContext,
  hub: RealtimeHub,
  subscriber: RealtimeSubscriber,
  uid: string,
  intent: SubscriptionIntent,
): Promise<Subscription> {
  const resource = await resolveTableResource(context, intent.schema, intent.table, "REALTIME");
  const key = await primaryKeyOf(context, resource.postgresOid);
  if (!key) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${intent.schema}.${intent.table}`);
  const subscription: Subscription = {
    uid,
    subscriber,
    resource,
    keyColumn: key.column,
    keyIsNumber: key.isNumber,
    events: intent.events,
    mode: intent.mode,
    query: intent.query,
  };
  const principal = await resolveDataPrincipal(context, subscriber.token ?? "");
  await authorizeIntent(context, principal, subscription, subscriber.origin());
  await hub.add(subscription);
  return subscription;
}

/**
 * The credential a Data API WebSocket upgrade carries (Data_API.md §16.3): a bearer header, or the session
 * cookie from this instance's own pages only - the WebSocket form of the CSRF rule; null, the first message
 * authenticates. A credential that doesn't resolve is refused before the upgrade.
 */
export async function upgradeToken(context: AppContext, request: FastifyRequest): Promise<string | null> {
  if (request.headers.authorization === undefined && request.headers.cookie === undefined) return null;
  let token: string | null;
  try {
    token = extractBearerToken(request);
  } catch {
    token = null;
  }
  if (token !== null && request.headers.authorization === undefined && !isSameOrigin(request, await context.auth.mailer.publicUrl())) {
    throw new TotalBaseError("CROSS_SITE_REQUEST_REFUSED", "A session cookie is only accepted from this instance's own pages.");
  }
  if (token !== null) await resolveDataPrincipal(context, token);
  return token;
}

/**
 * A subscription is an intent, authorized as a read with its `fields` and `where` would be (Data_API.md §16.4): READ, the
 * fields, the filter - and the primary key readable, since every event names its rows by it.
 */
async function authorizeIntent(context: AppContext, principal: DataPrincipal, subscription: Pick<Subscription, "resource" | "keyColumn" | "mode" | "query">, origin: ReadOrigin): Promise<void> {
  if (subscription.mode === "rows") {
    await authorizeRows(context, principal, subscription.resource, { ...subscription.query }, origin);
  }
  await authorizeRows(context, principal, subscription.resource, { fields: subscription.keyColumn }, origin);
}

/** Its single-column primary key and whether it goes out as a number (int2, int4). */
async function primaryKeyOf(context: AppContext, oid: number): Promise<{ column: string; isNumber: boolean } | null> {
  const { rows } = await context.database.query<{ column: string; type: number }>(
    `SELECT a.attname AS column, a.atttypid::int AS type
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = $1 AND i.indisprimary AND i.indnkeyatts = 1`,
    [oid],
  );
  const row = rows[0];
  return row ? { column: row.column, isNumber: row.type === 21 || row.type === 23 } : null;
}

/** What logical replication needs, read live (Data_API.md §16.1) - Settings > Realtime shows it, the upgrade checks it. */
export interface RealtimeRequirements {
  walLevel: string;
  replication: boolean;
  createOnDatabase: boolean;
  maxReplicationSlots: number;
  usedReplicationSlots: number;
  ready: boolean;
}

export async function realtimeRequirements(context: AppContext): Promise<RealtimeRequirements> {
  const { rows } = await context.database.query<{ wal_level: string; replication: boolean; create_on_database: boolean; max_slots: number; used_slots: number }>(
    `SELECT current_setting('wal_level') AS wal_level,
            (SELECT rolreplication FROM pg_catalog.pg_roles WHERE rolname = current_user) AS replication,
            has_database_privilege(current_database(), 'CREATE') AS create_on_database,
            current_setting('max_replication_slots')::int AS max_slots,
            (SELECT count(*)::int FROM pg_catalog.pg_replication_slots) AS used_slots`,
  );
  const row = rows[0]!;
  return {
    walLevel: row.wal_level,
    replication: row.replication,
    createOnDatabase: row.create_on_database,
    maxReplicationSlots: row.max_slots,
    usedReplicationSlots: row.used_slots,
    ready: row.wal_level === "logical" && row.replication,
  };
}

interface SubscribeMessage {
  uid?: unknown;
  data?: { resource?: unknown; event?: unknown; mode?: unknown; query?: unknown };
}

function invalid(message: string): TotalBaseError {
  return new TotalBaseError("INVALID_REALTIME_MESSAGE", message);
}

/**
 * The server's WebSocket upgrades, dispatched by path: /api/realtime and /api/graphql to @fastify/websocket, every other one to
 * the server's other upgrade listeners - the admin's development proxy (admin-ui.ts) forwards Vite's HMR socket.
 * Both plugins would otherwise take every upgrade, and the second to answer one crashes Node
 * (ERR_HTTP_SOCKET_ASSIGNED). Without another listener (production), another path is answered 404.
 */
function dispatchUpgrades(app: FastifyInstance): EventEmitter {
  const realtimeUpgrades = new EventEmitter();
  let others: ((...args: unknown[]) => void)[] = [];
  const dispatch = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/api/realtime" || path === "/api/graphql") {
      realtimeUpgrades.emit("upgrade", request, socket, head);
    } else if (others.length > 0) {
      for (const listener of others) listener.call(app.server, request, socket, head);
    } else {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  };
  app.server.on("upgrade", dispatch);
  // Once every plugin has added its own: they hear upgrades only through this one.
  app.addHook("onReady", async () => {
    others = app.server.listeners("upgrade").filter((listener) => listener !== dispatch) as typeof others;
    for (const listener of others) app.server.removeListener("upgrade", listener);
  });
  return realtimeUpgrades;
}

export async function registerRealtimeRoutes(app: FastifyInstance, context: AppContext): Promise<RealtimeHub> {
  // `server`: the plugin listens for upgrades on this emitter, not on the HTTP server (dispatchUpgrades).
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES, server: dispatchUpgrades(app) as unknown as Server } });
  const hub = new RealtimeHub(context);
  app.addHook("onClose", async () => hub.close());
  // The credential the upgrade carried (null: the first message authenticates), from preValidation to the handler.
  const upgradeTokens = new WeakMap<FastifyRequest, string | null>();

  app.get("/api/realtime", {
    websocket: true,
    // Refused before the upgrade, as an HTTP answer in the error envelope (Data_API.md §16.3).
    preValidation: async (request) => {
      if (!(await context.settings.get("realtime.enabled"))) throw new TotalBaseError("REALTIME_DISABLED", "Realtime is turned off (Settings > Realtime).");
      if (!(await realtimeRequirements(context)).ready) {
        throw new TotalBaseError("REALTIME_UNAVAILABLE", "Realtime needs PostgreSQL's logical replication (Settings > Realtime shows its requirements).");
      }
      upgradeTokens.set(request, await upgradeToken(context, request));
    },
  }, async (socket, request) => {
    const connection = new Connection(socket, upgradeTokens.get(request) ?? null, request);
    const heartbeatSeconds = await context.settings.get("realtime.heartbeat_seconds");
    const authTimer = connection.token === null
      ? setTimeout(() => connection.close(CLOSE_POLICY, new TotalBaseError("AUTHENTICATION_REQUIRED", "No credential within 10 seconds.")), AUTH_TIMEOUT_MS)
      : undefined;
    const heartbeat = setInterval(() => {
      if (connection.awaitingPong) {
        connection.close(CLOSE_TRY_LATER, new TotalBaseError("INVALID_REALTIME_MESSAGE", "No pong since the last ping."));
        return;
      }
      void context.settings.get("realtime.enabled").then((enabled) => {
        if (!enabled) connection.close(CLOSE_TRY_LATER, new TotalBaseError("REALTIME_DISABLED", "Realtime was turned off."));
        else {
          connection.awaitingPong = true;
          connection.send({ type: "ping" });
        }
      }, () => undefined);
    }, heartbeatSeconds * 1000);

    socket.on("close", () => {
      connection.closed = true;
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      for (const subscription of connection.subscriptions.values()) hub.remove(subscription);
      connection.subscriptions.clear();
    });

    // One message at a time, in order: a subscribe answers before the next message is read.
    let queue: Promise<void> = Promise.resolve();
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      queue = queue.then(() => handle(raw, isBinary)).catch((error: unknown) => {
        context.logger.error({ error }, "realtime message failed");
        connection.error(error);
      });
    });

    async function handle(raw: Buffer, isBinary: boolean): Promise<void> {
      if (connection.closed) return;
      let message: { type?: unknown; uid?: unknown; data?: unknown };
      try {
        if (isBinary) throw new Error("binary");
        message = JSON.parse(raw.toString("utf8")) as typeof message;
        if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("not an object");
      } catch {
        connection.error(invalid("A message is a JSON object in a text frame."));
        return;
      }
      if (message.type === "pong") {
        connection.awaitingPong = false;
        return;
      }
      if (message.type === "auth") {
        await authenticate(message.data);
        return;
      }
      if (connection.token === null) {
        connection.close(CLOSE_POLICY, new TotalBaseError("AUTHENTICATION_REQUIRED", "The first message authenticates: { type: \"auth\", data: { accessToken } }."));
        return;
      }
      if (message.type === "subscribe") await subscribe(message as SubscribeMessage);
      else if (message.type === "unsubscribe") unsubscribe(message.uid);
      else connection.error(invalid(`Unknown message type: ${String(message.type)}.`), typeof message.uid === "string" ? message.uid : undefined);
    }

    /** The first message without a credential at the upgrade; later, a fresh credential for the same connection. */
    async function authenticate(data: unknown): Promise<void> {
      const token = typeof data === "object" && data !== null ? (data as { accessToken?: unknown }).accessToken : undefined;
      if (typeof token !== "string" || token === "") {
        connection.close(CLOSE_POLICY, invalid("auth needs data.accessToken."));
        return;
      }
      try {
        await resolveDataPrincipal(context, token);
      } catch (error) {
        connection.close(CLOSE_POLICY, error);
        return;
      }
      connection.token = token;
      clearTimeout(authTimer);
      connection.send({ type: "auth", data: { status: "ok" } });
    }

    async function subscribe(message: SubscribeMessage): Promise<void> {
      const requestedUid = message.uid;
      if (requestedUid !== undefined && (typeof requestedUid !== "string" || requestedUid === "" || requestedUid.length > MAX_UID_LENGTH)) {
        connection.error(invalid(`uid is a non-empty text of at most ${MAX_UID_LENGTH} characters.`));
        return;
      }
      const uid = requestedUid ?? connection.generatedUid();
      try {
        if (connection.subscriptions.has(uid)) throw invalid(`This connection already has a subscription "${uid}".`);
        const data = message.data;
        if (typeof data !== "object" || data === null) throw invalid("subscribe needs data.resource.");
        const { resource: name, event, mode = "rows", query } = data;
        if (typeof name !== "string" || !/^[^.]+\..+$/.test(name)) throw invalid("data.resource is schema.table.");
        if (event !== undefined && !EVENTS.includes(event as RealtimeEvent)) throw invalid("data.event is create, update or delete.");
        if (mode !== "rows" && mode !== "summary") throw invalid("data.mode is rows or summary.");
        if (query !== undefined && (typeof query !== "object" || query === null || Array.isArray(query))) throw invalid("data.query is an object.");
        const queryObject = (query ?? {}) as Record<string, unknown>;
        const unknownKey = Object.keys(queryObject).find((key) => key !== "fields" && key !== "where");
        if (unknownKey !== undefined) throw new TotalBaseError("INVALID_QUERY", `A subscription's query takes only fields and where, not ${unknownKey}.`);
        if (mode === "summary" && Object.keys(queryObject).length > 0) throw invalid("A summary subscription takes no query.");
        if (connection.subscriptions.size >= (await context.settings.get("realtime.max_subscriptions"))) {
          throw new TotalBaseError("TOO_MANY_SUBSCRIPTIONS", "This connection holds as many subscriptions as realtime.max_subscriptions allows.");
        }

        const dot = name.indexOf(".");
        const subscription = await openSubscription(context, hub, connection, uid, {
          schema: name.slice(0, dot),
          table: name.slice(dot + 1),
          events: new Set(event === undefined ? EVENTS : [event as RealtimeEvent]),
          mode,
          query: { ...(queryObject.fields !== undefined && { fields: queryObject.fields }), ...(queryObject.where !== undefined && { where: queryObject.where }) },
        });
        if (connection.closed) {
          hub.remove(subscription);
          return;
        }
        connection.subscriptions.set(uid, subscription);
        connection.event(uid, "init");
      } catch (error) {
        connection.error(error, uid);
      }
    }

    function unsubscribe(uid: unknown): void {
      const ending = uid === undefined ? [...connection.subscriptions.values()] : [connection.subscriptions.get(String(uid))].filter((s) => s !== undefined);
      for (const subscription of ending) {
        hub.remove(subscription);
        connection.subscriptions.delete(subscription.uid);
      }
    }
  });
  return hub;
}

/** Settings > Realtime's status (Data_API.md §16.1): the requirements, read live, and how many tables expose REALTIME. */
export function registerAdminRealtimeRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/admin/api/realtime", {
    preHandler: requireAdmin(context),
    ...adminDoc("settings", {
      summary: "Realtime's requirements",
      description: "What realtime subscriptions need from PostgreSQL, read live: `wal_level = logical`, the REPLICATION attribute on TotalBase's role, CREATE on the database (for the publication) and a free replication slot per server process with subscribers; and how many tables expose REALTIME.",
      response: ok(object({
        walLevel: { type: "string" },
        replication: { type: "boolean" },
        createOnDatabase: { type: "boolean" },
        maxReplicationSlots: { type: "integer" },
        usedReplicationSlots: { type: "integer" },
        ready: { type: "boolean" },
        tables: { type: "integer" },
      }, ["walLevel", "replication", "createOnDatabase", "maxReplicationSlots", "usedReplicationSlots", "ready", "tables"])),
    }),
  }, async () => {
    const [requirements, { rows }] = await Promise.all([
      realtimeRequirements(context),
      context.database.query<{ tables: number }>(`SELECT count(*)::int AS tables FROM totalbase.resources WHERE status = 'ACTIVE' AND 'REALTIME' = ANY(exposed_methods)`),
    ]);
    return { data: { ...requirements, tables: rows[0]?.tables ?? 0 } };
  });
}
