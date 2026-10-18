import type { Queryable } from "@totalbase/database";

/** One schema-management operation's DDL, as it ran. */
export interface DdlRecord {
  /** The operation, e.g. "create_table", "add_column", "edit_table", "drop_view". */
  operation: string;
  /** The statements, in the order they ran. */
  statements: string[];
  /**
   * An edit batch's CONCURRENTLY statement, which ran on its own after the
   * batch's transaction committed - recorded after it ran, not inside a
   * transaction with it (PostgreSQL forbids that).
   */
  concurrent?: boolean;
}

/**
 * Records one schema-management operation (Specification_Administration.md
 * §3.14). Called with the transaction client the DDL ran on, after the
 * statements and before the commit - the record and the DDL commit or roll
 * back together. The caller (the Admin API route) knows who acts and on
 * what; this package only says what ran.
 */
export type DdlAuditor = (client: Queryable, record: DdlRecord) => Promise<void>;

/** Runs statements in one transaction, then whatever belongs with them, then the auditor - all or nothing. */
export async function runDdl(
  database: { transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> },
  operation: string,
  statements: string[],
  audit: DdlAuditor | undefined,
  alongside?: (client: Queryable) => Promise<void>,
): Promise<void> {
  await database.transaction(async (client) => {
    for (const sql of statements) await client.query(sql);
    if (alongside) await alongside(client);
    if (audit) await audit(client, { operation, statements });
  });
}
