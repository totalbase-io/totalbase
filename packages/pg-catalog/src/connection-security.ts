import type { Database } from "@totalbase/database";

/**
 * How TotalBase's own connection to PostgreSQL stands, read from PostgreSQL itself - the Status page's security
 * notes (Administration.md §1.6). Every pooled connection is opened the same way, so the one that answers speaks
 * for all of them.
 */
export interface ConnectionSecurity {
  /** The connection's role is a superuser: TotalBase never needs it (Foundations.md §6), and it bypasses every privilege. */
  superuser: boolean;
  /**
   * What else the role holds that reaches past its database, none of it TotalBase's need (a superuser holds them
   * all - `superuser` says so, this is then empty): CREATEROLE (on PostgreSQL 15 it can grant itself almost any
   * role), BYPASSRLS, REPLICATION (Realtime's need only, Data_API.md §16.1 - the caller decides), and the membership
   * of `pg_execute_server_program` (a command on the server's operating system from SQL: the SQL Console's
   * `COPY ... FROM PROGRAM`), `pg_read_server_files`, `pg_write_server_files`.
   */
  privileges: ConnectionPrivilege[];
  /** `password_encryption`: how PostgreSQL hashes a password set from now on - `scram-sha-256` unless set otherwise. */
  passwordEncryption: string;
  /** The connection is encrypted (`pg_stat_ssl`). */
  ssl: boolean;
  /**
   * The server is reached over a private network: a Unix socket, loopback, or a private range
   * (10/8, 172.16/12, 192.168/16, fc00::/7 - a Docker network, a LAN). A connection without TLS outside one
   * crosses networks nobody here controls.
   */
  privateNetwork: boolean;
}

export type ConnectionPrivilege =
  | "CREATEROLE"
  | "BYPASSRLS"
  | "REPLICATION"
  | "pg_execute_server_program"
  | "pg_read_server_files"
  | "pg_write_server_files";

const SERVER_ROLES = ["pg_execute_server_program", "pg_read_server_files", "pg_write_server_files"] as const;

export async function getConnectionSecurity(database: Database): Promise<ConnectionSecurity> {
  const { rows } = await database.query<{
    superuser: boolean;
    createrole: boolean;
    bypassrls: boolean;
    replication: boolean;
    server_roles: string[];
    password_encryption: string;
    ssl: boolean;
    private_network: boolean;
  }>(
    `SELECT r.rolsuper AS superuser, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls, r.rolreplication AS replication,
            ARRAY(SELECT g FROM unnest($1::text[]) AS g WHERE pg_catalog.pg_has_role(current_user, g, 'MEMBER')) AS server_roles,
            current_setting('password_encryption') AS password_encryption,
            COALESCE((SELECT s.ssl FROM pg_catalog.pg_stat_ssl s WHERE s.pid = pg_catalog.pg_backend_pid()), false) AS ssl,
            COALESCE(inet_server_addr() <<= ANY (ARRAY['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7']::inet[]), true)
              AS private_network
       FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user`,
    [SERVER_ROLES],
  );
  const row = rows[0]!;
  const privileges: ConnectionPrivilege[] = row.superuser
    ? []
    : [
        ...(row.createrole ? (["CREATEROLE"] as const) : []),
        ...(row.bypassrls ? (["BYPASSRLS"] as const) : []),
        ...(row.replication ? (["REPLICATION"] as const) : []),
        ...SERVER_ROLES.filter((role) => row.server_roles.includes(role)),
      ];
  return { superuser: row.superuser, privileges, passwordEncryption: row.password_encryption, ssl: row.ssl, privateNetwork: row.private_network };
}
