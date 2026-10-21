import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * TotalBase V1 supports PostgreSQL 15-18.
 * See Foundations.md §6.
 */
const MIN_SUPPORTED_MAJOR = 15;
const MAX_SUPPORTED_MAJOR = 18;

export async function assertSupportedPostgresVersion(database: Database): Promise<void> {
  // Read once and kept by the Database: version-gated SQL (PostgreSQL 18's
  // RETURNING OLD in UPDATE audit, Security.md §11.4) asks it again.
  const major = await database.serverMajorVersion();

  if (major < MIN_SUPPORTED_MAJOR || major > MAX_SUPPORTED_MAJOR) {
    throw new TotalBaseError(
      "INTERNAL_ERROR",
      `Unsupported PostgreSQL major version: ${major}. ` +
        `TotalBase V1 supports PostgreSQL ${MIN_SUPPORTED_MAJOR}-${MAX_SUPPORTED_MAJOR}.`,
    );
  }
}
