import { randomBytes } from "node:crypto";
import pg from "pg";
import type { DatabaseConfig } from "./config.js";
import { quoteIdentifier } from "./identifiers.js";
import type { Subscription } from "./listener.js";

/**
 * Logical replication for realtime subscriptions (Data_API.md §16): one temporary `pgoutput` slot on a
 * connection of its own, outside the pool, decoding only what TotalBase uses - which rows of which table a
 * committed transaction inserted, updated or deleted, by their single-column primary key as text, and which
 * tables it truncated. The rows themselves are read again by whoever subscribed, with their permissions.
 *
 * Protocol version 1, the messages Begin, Relation, Insert, Update, Delete, Truncate and Commit
 * (https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html); Type, Origin and
 * anything else are skipped. Each transaction is acknowledged as soon as it is decoded: nothing is replayed,
 * so the slot never holds WAL back.
 */

/** The keys one transaction changed in one table by one event, up to `maxKeys`; past it, only `overflow`. */
export interface ChangedKeys {
  keys: string[];
  overflow: boolean;
}

export interface RelationChanges {
  insert: ChangedKeys;
  update: ChangedKeys;
  delete: ChangedKeys;
  truncate: boolean;
}

/** A committed transaction's changes, by table OID (a partition's under its root's, publish_via_partition_root). */
export type ReplicatedTransaction = ReadonlyMap<number, RelationChanges>;

export interface ReplicationOptions {
  publication: string;
  /** Keys kept per table and event in one transaction (api.max_limit); read at each transaction. */
  maxKeys: () => number;
}

export interface ReplicationHandlers {
  onTransaction(transaction: ReplicatedTransaction): void;
  /** The connection came back after a loss, on a new slot: what was committed meanwhile is unknown. */
  onReconnect(): void;
  /** The connection was lost or a reconnect failed (it keeps retrying). */
  onError?(error: unknown): void;
}

interface RelationInfo {
  /** The key column's position among the relation's columns; null unless exactly one key column. */
  keyIndex: number | null;
}

type TupleValue = string | null | undefined;

/** A pgoutput message stream as transactions - pure, so it is tested on bytes alone. */
export class PgoutputDecoder {
  private readonly relations = new Map<number, RelationInfo>();
  private current: Map<number, RelationChanges> | null = null;
  private buffer!: Buffer;
  private offset = 0;

  constructor(private readonly maxKeys: () => number) {}

  /**
   * One pgoutput message. Returns the transaction a Commit completes, with the LSN to acknowledge;
   * otherwise null.
   */
  decode(message: Buffer): { transaction: ReplicatedTransaction; endLsn: bigint } | null {
    this.buffer = message;
    this.offset = 1;
    switch (message[0]) {
      case 0x42 /* B */:
        this.current = new Map();
        return null;
      case 0x52 /* R */:
        this.relation();
        return null;
      case 0x49 /* I */: {
        const relation = this.int32();
        this.offset += 1; // 'N'
        this.record(relation, "insert", this.key(relation, this.tuple()));
        return null;
      }
      case 0x55 /* U */:
        this.update();
        return null;
      case 0x44 /* D */: {
        const relation = this.int32();
        this.offset += 1; // 'K' or 'O'
        this.record(relation, "delete", this.key(relation, this.tuple()));
        return null;
      }
      case 0x54 /* T */:
        this.truncate();
        return null;
      case 0x43 /* C */: {
        this.offset += 1 + 8; // flags, commit LSN
        const endLsn = this.buffer.readBigUInt64BE(this.offset);
        const transaction = this.current ?? new Map();
        this.current = null;
        return { transaction, endLsn };
      }
      default:
        return null;
    }
  }

  private relation(): void {
    const oid = this.int32();
    this.string(); // namespace
    this.string(); // name
    this.offset += 1; // replica identity
    const columns = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    const keys: number[] = [];
    for (let index = 0; index < columns; index++) {
      const flags = this.buffer[this.offset]!;
      this.offset += 1;
      this.string(); // name
      this.offset += 8; // type OID, type modifier
      if (flags & 1) keys.push(index);
    }
    this.relations.set(oid, { keyIndex: keys.length === 1 ? keys[0]! : null });
  }

  /** An update; one that changed the primary key is a delete of the old key and an update of the new. */
  private update(): void {
    const relation = this.int32();
    let oldKey: string | null = null;
    const tag = this.buffer[this.offset];
    if (tag === 0x4b /* K */ || tag === 0x4f /* O */) {
      this.offset += 1;
      oldKey = this.key(relation, this.tuple());
    }
    this.offset += 1; // 'N'
    const newKey = this.key(relation, this.tuple());
    if (oldKey !== null && oldKey !== newKey) this.record(relation, "delete", oldKey);
    this.record(relation, "update", newKey);
  }

  private truncate(): void {
    const count = this.int32();
    this.offset += 1; // options
    for (let index = 0; index < count; index++) this.changes(this.int32()).truncate = true;
  }

  /** The key's text, or null when it can't be told (no single key column, a null or unchanged value). */
  private key(relation: number, tuple: TupleValue[]): string | null {
    const keyIndex = this.relations.get(relation)?.keyIndex;
    if (keyIndex === null || keyIndex === undefined) return null;
    return tuple[keyIndex] ?? null;
  }

  /** A null key counts as an overflow: the change happened, which row it was can't be said. */
  private record(relation: number, event: "insert" | "update" | "delete", key: string | null): void {
    const changed = this.changes(relation)[event];
    if (changed.overflow) return;
    if (key === null || changed.keys.length >= this.maxKeys()) {
      changed.overflow = true;
      changed.keys = [];
      return;
    }
    changed.keys.push(key);
  }

  private changes(relation: number): RelationChanges {
    this.current ??= new Map();
    let changes = this.current.get(relation);
    if (!changes) {
      changes = {
        insert: { keys: [], overflow: false },
        update: { keys: [], overflow: false },
        delete: { keys: [], overflow: false },
        truncate: false,
      };
      this.current.set(relation, changes);
    }
    return changes;
  }

  /** TupleData: text values, null for SQL NULL, undefined for an unchanged TOASTed value. */
  private tuple(): TupleValue[] {
    const columns = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    const values: TupleValue[] = [];
    for (let index = 0; index < columns; index++) {
      const kind = this.buffer[this.offset]!;
      this.offset += 1;
      if (kind === 0x74 /* t */ || kind === 0x62 /* b */) {
        const length = this.int32();
        values.push(this.buffer.toString("utf8", this.offset, this.offset + length));
        this.offset += length;
      } else {
        values.push(kind === 0x6e /* n */ ? null : undefined);
      }
    }
    return values;
  }

  private int32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value >>> 0;
  }

  private string(): string {
    const end = this.buffer.indexOf(0, this.offset);
    const value = this.buffer.toString("utf8", this.offset, end);
    this.offset = end + 1;
    return value;
  }
}

/** The connection a submitted query is handed - only what the stream sends back with. */
interface CopyConnection {
  sendCopyFromChunk(chunk: Buffer): void;
}

/** Microseconds since 2000-01-01, the protocol's clock. */
function protocolNow(): bigint {
  return (BigInt(Date.now()) - 946_684_800_000n) * 1000n;
}

/** A Standby Status Update: everything up to `lsn` is written, flushed and applied - the slot may let it go. */
function standbyStatus(lsn: bigint): Buffer {
  const message = Buffer.alloc(34);
  message[0] = 0x72; // 'r'
  message.writeBigUInt64BE(lsn, 1);
  message.writeBigUInt64BE(lsn, 9);
  message.writeBigUInt64BE(lsn, 17);
  message.writeBigUInt64BE(protocolNow(), 25);
  message[33] = 0;
  return message;
}

/**
 * START_REPLICATION as a node-postgres Submittable - the extension point pg-cursor and pg-copy-streams use:
 * the client hands it the connection and forwards CopyData to it, so nothing reaches into the client's
 * internals.
 */
class ReplicationStream implements pg.Submittable {
  private connection: CopyConnection | null = null;
  private lsn = 0n;
  private inTransaction = false;

  constructor(
    private readonly sql: string,
    private readonly decoder: PgoutputDecoder,
    private readonly onTransaction: (transaction: ReplicatedTransaction) => void,
    private readonly onEnd: (error?: unknown) => void,
  ) {}

  submit(connection: pg.Connection): void {
    // sendCopyFromChunk is the Connection's own (pg-copy-streams writes with it), not in pg's types.
    this.connection = connection as unknown as CopyConnection;
    connection.query(this.sql);
  }

  handleCopyData(message: { chunk: Buffer }): void {
    const chunk = message.chunk;
    if (chunk[0] === 0x77 /* w: XLogData */) {
      const data = chunk.subarray(25);
      if (data[0] === 0x42) this.inTransaction = true;
      const done = this.decoder.decode(data);
      if (done) {
        this.inTransaction = false;
        this.acknowledge(done.endLsn);
        this.onTransaction(done.transaction);
      }
    } else if (chunk[0] === 0x6b /* k: Primary keepalive */) {
      // Between transactions, the server's end of WAL is ours too - nothing in it is for us.
      if (!this.inTransaction) this.lsn = this.lsn > chunk.readBigUInt64BE(1) ? this.lsn : chunk.readBigUInt64BE(1);
      if (chunk[17] === 1) this.acknowledge(this.lsn);
    }
  }

  private acknowledge(lsn: bigint): void {
    if (lsn > this.lsn) this.lsn = lsn;
    this.connection?.sendCopyFromChunk(standbyStatus(this.lsn));
  }

  handleError(error: unknown): void {
    this.onEnd(error);
  }

  handleReadyForQuery(): void {
    this.onEnd();
  }

  handleCommandComplete(): void {}
  handleRowDescription(): void {}
  handleDataRow(): void {}
  handleEmptyQuery(): void {}
  handlePortalSuspended(): void {}
  handleCopyInResponse(): void {}
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Replicates `options.publication` on a temporary slot of this process's own. The first connection's
 * failure is thrown (a missing requirement, Data_API.md §16.1); a later loss reconnects with a growing
 * delay on a new slot and reports `onReconnect`. `close()` ends it - the slot goes with its connection.
 */
export async function replicate(config: DatabaseConfig, options: ReplicationOptions, handlers: ReplicationHandlers): Promise<Subscription> {
  let client: pg.Client | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    const next = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      keepAlive: true,
      connectionTimeoutMillis: config.poolConnectionTimeoutMs,
      application_name: "totalbase realtime",
      // A logical replication connection (pg's own connection parameter, not in its types).
      ...({ replication: "database" } as object),
    });
    next.on("error", (error) => {
      handlers.onError?.(error);
      lost(next);
    });
    next.on("end", () => lost(next));
    try {
      await next.connect();
      const slot = `totalbase_realtime_${process.pid}_${randomBytes(4).toString("hex")}`;
      await next.query(`CREATE_REPLICATION_SLOT ${quoteIdentifier(slot)} TEMPORARY LOGICAL pgoutput (SNAPSHOT 'nothing')`);
      const publication = options.publication.replace(/'/g, "''");
      const stream = new ReplicationStream(
        `START_REPLICATION SLOT ${quoteIdentifier(slot)} LOGICAL 0/0 (proto_version '1', publication_names '${publication}')`,
        new PgoutputDecoder(options.maxKeys),
        (transaction) => handlers.onTransaction(transaction),
        (error) => {
          // The stream ends with its connection: closed on purpose, or already replaced, it's no loss.
          if (closed || client !== next) return;
          if (error) handlers.onError?.(error);
          lost(next);
        },
      );
      next.query(stream);
    } catch (error) {
      next.removeAllListeners();
      await next.end().catch(() => undefined);
      throw error;
    }
    client = next;
  };

  const lost = (which: pg.Client) => {
    if (closed || client !== which) return;
    client = null;
    which.removeAllListeners();
    which.end().catch(() => undefined);
    scheduleReconnect();
  };

  const scheduleReconnect = () => {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    attempt += 1;
    retryTimer = setTimeout(() => {
      connect().then(
        () => {
          attempt = 0;
          if (closed) void client?.end();
          else handlers.onReconnect();
        },
        (error: unknown) => {
          handlers.onError?.(error);
          if (!closed) scheduleReconnect();
        },
      );
    }, delay);
  };

  await connect();
  return {
    async close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const current = client;
      client = null;
      if (current) {
        current.removeAllListeners();
        // Never a dangling 'error' on a socket torn down mid-stream.
        current.on("error", () => undefined);
        await current.end().catch(() => undefined);
      }
    },
  };
}
