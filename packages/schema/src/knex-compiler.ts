import knexFactory from "knex";
import type { Knex } from "knex";

/**
 * Compile-only Knex instance - constructed with a `client` but no
 * `connection`, so it never opens a socket. Every `buildXSql()` function
 * in this package uses it purely to compile a schema-builder call to SQL
 * text (`.toString()`/`.toSQL()`); the resulting text still executes
 * through @totalbase/database's own Database.query()/transaction()
 * exactly as before Knex was introduced. This is what keeps "only
 * @totalbase/database imports `pg` directly" true - Knex here never
 * touches a live connection at all.
 *
 * `client` is where a future engine selection would plug in (MySQL/
 * MariaDB/SQL Server) - Postgres is the only one wired up today.
 */
export function createKnexCompiler(client: "pg" = "pg"): Knex {
  return knexFactory({ client });
}

export const knex: Knex = createKnexCompiler();
