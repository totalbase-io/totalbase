import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { TotalBaseError } from "@totalbase/errors";
import { subscribeGraphQL, type GraphQLChange, type GraphQLDataExecutor } from "@totalbase/graphql";
import type { AppContext } from "../context.js";
import { resolveDataPrincipal } from "../data-principal.js";
import type { ReadOrigin } from "../read-audit.js";
import {
  openSubscription,
  realtimeRequirements,
  upgradeToken,
  type RealtimeDelivery,
  type RealtimeHub,
  type RealtimeSubscriber,
} from "../realtime.js";
import { executorFor, graphqlSchemaFor } from "./graphql.js";

/** The protocol of the graphql-ws library, what GraphQL clients speak over a WebSocket. */
const PROTOCOL = "graphql-transport-ws";
const INIT_TIMEOUT_MS = 10_000;
/** Past this much unsent on a socket, the client isn't reading: it is closed (Data_API.md §16.7). */
const MAX_BUFFERED_BYTES = 1024 * 1024;

// graphql-transport-ws's close codes; 1013, as /api/realtime, for a client to come back later.
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_SUBPROTOCOL = 4406;
const CLOSE_INIT_TIMEOUT = 4408;
const CLOSE_DUPLICATE_ID = 4409;
const CLOSE_TOO_MANY_INITS = 4429;
const CLOSE_TRY_LATER = 1013;

/** A push-fed async iterator: the hub pushes changes, graphql-js pulls them; returning it ends the subscription. */
class Channel<T> implements AsyncIterableIterator<T> {
  private readonly queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  done = false;

  constructor(private readonly onReturn: () => void) {}

  push(value: T): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  /** Ends the stream once what's queued is read. */
  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiting && this.queue.length === 0) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
    this.onReturn();
  }

  next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => (this.waiting = resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.queue.length = 0;
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

/** The credential connection_init may carry: `{ accessToken }`, or an `Authorization: Bearer` as a client's connection params. */
function tokenOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { accessToken, authorization, Authorization } = payload as Record<string, unknown>;
  if (typeof accessToken === "string" && accessToken !== "") return accessToken;
  const header = typeof authorization === "string" ? authorization : typeof Authorization === "string" ? Authorization : undefined;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

/**
 * GraphQL over a WebSocket at /api/graphql (Data_API.md §17.7): the graphql-transport-ws protocol, so
 * a GraphQL client's own WebSocket link connects as is. Queries and mutations run as over HTTP; a subscription
 * is a realtime subscription (Data_API.md §16) opened in the same hub as /api/realtime's, with the same rules:
 * the credential of a Data API surface, resolved again before each delivery; the intent authorized as a read
 * before it exists; each change read again with the subscriber's grants.
 */
export function registerGraphQLWebSocket(app: FastifyInstance, context: AppContext, hub: RealtimeHub): void {
  const upgradeTokens = new WeakMap<FastifyRequest, string | null>();

  app.get("/api/graphql", {
    websocket: true,
    preValidation: async (request) => {
      if ((await context.settings.get("graphql.enabled")) !== true) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "GraphQL is off on this instance - an administrator turns it on in Settings > GraphQL.");
      }
      upgradeTokens.set(request, await upgradeToken(context, request));
    },
  }, (socket: WebSocket, request) => {
    if (socket.protocol !== PROTOCOL) {
      socket.close(CLOSE_SUBPROTOCOL, `Subprotocol not acceptable: use ${PROTOCOL}`);
      return;
    }
    let token = upgradeTokens.get(request) ?? null;
    let initialized = false;
    let acknowledged = false;
    let closed = false;
    let awaitingPong = false;
    /** Each operation by its id: how to stop it. */
    const operations = new Map<string, () => void>();

    const origin = (): ReadOrigin => ({ requestId: randomUUID(), ip: request.ip, userAgent: request.headers["user-agent"] });
    const send = (message: Record<string, unknown>) => {
      if (closed || socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        close(CLOSE_TRY_LATER, "The connection fell too far behind reading its messages.");
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      for (const stop of operations.values()) stop();
      operations.clear();
      socket.close(code, reason.slice(0, 120));
    };

    const initTimer = setTimeout(() => {
      if (!acknowledged) close(CLOSE_INIT_TIMEOUT, "Connection initialisation timeout");
    }, INIT_TIMEOUT_MS);
    let heartbeat: NodeJS.Timeout | undefined;
    void context.settings.get("realtime.heartbeat_seconds").then((seconds) => {
      if (closed) return;
      heartbeat = setInterval(() => {
        if (awaitingPong) {
          close(CLOSE_TRY_LATER, "No pong since the last ping.");
          return;
        }
        void context.settings.get("graphql.enabled").then((enabled) => {
          if (!enabled) close(CLOSE_TRY_LATER, "GraphQL was turned off.");
          else {
            awaitingPong = true;
            send({ type: "ping" });
          }
        }, () => undefined);
      }, seconds * 1000);
    });

    socket.on("close", () => {
      closed = true;
      clearTimeout(initTimer);
      clearInterval(heartbeat);
      for (const stop of operations.values()) stop();
      operations.clear();
    });

    // One message at a time, in order - an operation starts before the next message is read.
    let queue: Promise<void> = Promise.resolve();
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      queue = queue.then(() => handle(raw, isBinary)).catch((error: unknown) => {
        context.logger.error({ error }, "graphql websocket message failed");
        close(CLOSE_BAD_REQUEST, "Internal error.");
      });
    });

    async function handle(raw: Buffer, isBinary: boolean): Promise<void> {
      if (closed) return;
      let message: { type?: unknown; id?: unknown; payload?: unknown };
      try {
        if (isBinary) throw new Error("binary");
        message = JSON.parse(raw.toString("utf8")) as typeof message;
        if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("not an object");
      } catch {
        close(CLOSE_BAD_REQUEST, "Invalid message received");
        return;
      }
      switch (message.type) {
        case "connection_init":
          return init(message.payload);
        case "ping":
          send({ type: "pong" });
          return;
        case "pong":
          awaitingPong = false;
          return;
        case "subscribe":
          return start(message.id, message.payload);
        case "complete":
          if (typeof message.id === "string") operations.get(message.id)?.();
          return;
        default:
          close(CLOSE_BAD_REQUEST, `Invalid message type: ${String(message.type)}`);
      }
    }

    async function init(payload: unknown): Promise<void> {
      if (initialized) {
        close(CLOSE_TOO_MANY_INITS, "Too many initialisation requests");
        return;
      }
      initialized = true;
      token = tokenOf(payload) ?? token;
      if (token === null) {
        close(CLOSE_FORBIDDEN, "Forbidden: connection_init carries no credential");
        return;
      }
      try {
        await resolveDataPrincipal(context, token);
      } catch (error) {
        close(CLOSE_FORBIDDEN, error instanceof Error ? error.message : "Forbidden");
        return;
      }
      acknowledged = true;
      clearTimeout(initTimer);
      send({ type: "connection_ack" });
    }

    async function start(id: unknown, payload: unknown): Promise<void> {
      if (!acknowledged) {
        close(CLOSE_UNAUTHORIZED, "Unauthorized");
        return;
      }
      if (typeof id !== "string" || id === "") {
        close(CLOSE_BAD_REQUEST, "subscribe needs an id");
        return;
      }
      if (operations.has(id)) {
        close(CLOSE_DUPLICATE_ID, `Subscriber for ${id} already exists`);
        return;
      }
      // The credential, live: resolved again for every operation.
      let principal;
      try {
        principal = await resolveDataPrincipal(context, token!);
      } catch (error) {
        close(CLOSE_FORBIDDEN, error instanceof Error ? error.message : "Forbidden");
        return;
      }
      let stopped = false;
      const stoppers: (() => void)[] = [];
      operations.set(id, () => {
        stopped = true;
        for (const stop of stoppers) stop();
      });

      const executor: GraphQLDataExecutor = { ...executorFor(context, principal, origin, { idempotencyKey: false }), subscribe: (ref, intent) => subscribeTo(ref, intent) };
      const subscribeTo: NonNullable<GraphQLDataExecutor["subscribe"]> = async (ref, intent) => {
        if (ref.type !== "TABLE") throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${ref.schema}.${ref.name}`);
        if (!(await context.settings.get("realtime.enabled"))) throw new TotalBaseError("REALTIME_DISABLED", "Realtime is turned off (Settings > Realtime).");
        if (!(await realtimeRequirements(context)).ready) {
          throw new TotalBaseError("REALTIME_UNAVAILABLE", "Realtime needs PostgreSQL's logical replication (Settings > Realtime shows its requirements).");
        }
        const active = [...operations.keys()].length;
        if (active > (await context.settings.get("realtime.max_subscriptions"))) {
          throw new TotalBaseError("TOO_MANY_SUBSCRIPTIONS", "This connection holds as many subscriptions as realtime.max_subscriptions allows.");
        }
        let subscription: Awaited<ReturnType<typeof openSubscription>> | undefined;
        const channel = new Channel<GraphQLChange>(() => {
          if (subscription) hub.remove(subscription);
        });
        stoppers.push(() => channel.end());
        const subscriber: RealtimeSubscriber = {
          get closed() {
            return closed || channel.done;
          },
          get token() {
            return token;
          },
          origin,
          event: (_uid: string, event: RealtimeDelivery, data?: Record<string, unknown>[]) => channel.push({ event, ...(data !== undefined && { data }) }),
          // An error is delivered as the next message's errors; its event isn't read.
          failed: (_uid: string, error: unknown) => channel.push({ event: "reset", error }),
          ended: (_uid: string, error: unknown) => {
            channel.push({ event: "reset", error });
            channel.end();
          },
          refused: (error: unknown) => close(CLOSE_FORBIDDEN, error instanceof Error ? error.message : "Forbidden"),
        };
        subscription = await openSubscription(context, hub, subscriber, id, {
          schema: ref.schema,
          table: ref.name,
          events: new Set(intent.events),
          mode: intent.mode,
          query: intent.mode === "rows" ? { ...(intent.fields !== undefined && { fields: intent.fields }), ...(intent.where !== undefined && { where: intent.where }) } : {},
        });
        if (closed || stopped) {
          hub.remove(subscription);
          channel.end();
        } else {
          channel.push({ event: "init" });
        }
        return channel;
      };

      const { schema, limits } = await graphqlSchemaFor(context, principal);
      const result = await subscribeGraphQL(schema, payload, { executor }, limits, (error) => request.log.error(error));
      if (!(Symbol.asyncIterator in result)) {
        // A query or mutation ran once; a request that couldn't run is an `error` message.
        if (result.status === 200) {
          send({ type: "next", id, payload: result.body });
          send({ type: "complete", id });
        } else {
          send({ type: "error", id, payload: result.body.errors ?? [] });
        }
        operations.delete(id);
        return;
      }
      stoppers.push(() => void result.return(undefined));
      if (stopped) {
        await result.return(undefined);
        return;
      }
      void (async () => {
        try {
          for await (const body of result) send({ type: "next", id, payload: body });
        } finally {
          // Ended by the server (the subscription refused, the connection closing): the client hears it.
          if (operations.delete(id) && !stopped) send({ type: "complete", id });
        }
      })();
    }
  });
}
