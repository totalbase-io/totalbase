export interface SqlConsolePrefill {
  sql: string
  label: string
}

export function useSqlConsolePrefill() {
  return useState<SqlConsolePrefill | null>('sql-console-prefill', () => null)
}
