/** A PostgreSQL NOTICE/WARNING raised during query execution. */
export interface PostgresNotice {
  severity: string;
  message: string;
  detail?: string | undefined;
  hint?: string | undefined;
  code?: string | undefined;
}
