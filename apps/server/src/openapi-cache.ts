import type { Database } from "@totalbase/database";

/**
 * openapi.cache_enabled: generated Data API documents, kept per viewer
 * (principal type + role set) while nothing they describe has changed.
 *
 * "Has anything changed" has two sources:
 * - PostgreSQL's own change log: triggers on
 *   every table a document is built from - resources, permissions,
 *   roles, workflows, settings... - add a row, whoever writes them.
 * - A catalog epoch, bumped by invalidate() when DDL may have changed a
 *   table's columns (an Admin API write - schema management, the SQL
 *   Console - or a catalog refresh), which no trigger can see.
 *
 * Checking costs one single-row query per request, against rebuilding a
 * document that queries every exposed resource. The version is the newest
 * OPENAPI row's created_at plus how many rows the last minute holds, both
 * from the (topic, created_at) index - never a count of the whole log,
 * which grows with every change until the hourly prune (it reached 700k
 * rows in a test database). The recent count is there for commit order:
 * a row's created_at is its insert time (clock_timestamp), so a write
 * whose transaction commits after a later-stamped one leaves max() where
 * it was; counting the last minute's rows still moves the version when it
 * lands. A transaction open for over a minute around such a write is the
 * remaining gap - a document at most stale until the next change.
 */
export class OpenApiDocumentCache {
  private readonly documents = new Map<string, { version: string; document: Promise<unknown> }>();
  private epoch = 0;

  constructor(private readonly database: Database) {}

  async get<T>(key: string, build: () => Promise<T>): Promise<T> {
    const { rows } = await this.database.query<{ recent: string; latest: Date | null }>(
      `SELECT (SELECT max(created_at) FROM totalbase.invalidations WHERE topic = 'OPENAPI') AS latest,
              (SELECT count(*) FROM totalbase.invalidations WHERE topic = 'OPENAPI' AND created_at > now() - interval '1 minute') AS recent`,
    );
    const version = `${rows[0]?.recent}:${rows[0]?.latest?.toISOString() ?? "none"}:${this.epoch}`;
    const cached = this.documents.get(key);
    if (cached && cached.version === version) return cached.document as Promise<T>;
    const document = build();
    this.documents.set(key, { version, document });
    // A failed build isn't kept - the next request tries again.
    document.catch(() => {
      if (this.documents.get(key)?.document === document) this.documents.delete(key);
    });
    return document;
  }

  /** The catalog may have changed (DDL): every cached document is stale. */
  invalidate(): void {
    this.epoch += 1;
    this.documents.clear();
  }
}
