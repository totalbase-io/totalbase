import { TotalBaseError } from "@totalbase/errors";
import type { RecordedResponse } from "@totalbase/idempotency";
import type { AppContext } from "./context.js";
import type { DataPrincipal } from "./data-principal.js";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const IDEMPOTENCY_KEY_PATTERN = /^[\w.-]{1,255}$/;

/**
 * Runs `fn` (a route handler body that returns the HTTP status/body it
 * wants to send) under Idempotency Key protection when the client sent an
 * `Idempotency-Key` header (Data_API.md §9).
 * Without the header, `fn` just runs directly - idempotency is opt-in per
 * request - unless `required` (the resource's require_idempotency_key,
 * §9.1): then a request without one is IDEMPOTENCY_KEY_REQUIRED, while
 * idempotency.enabled is on (off, the header is ignored, and so is the
 * requirement).
 */
export async function withIdempotency(
  context: AppContext,
  headers: Record<string, unknown>,
  dataPrincipal: DataPrincipal,
  operationScope: string,
  method: string,
  body: unknown,
  fn: () => Promise<RecordedResponse>,
  required = false,
): Promise<RecordedResponse> {
  const rawKey = headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    if (required && (await context.settings.get("idempotency.enabled"))) {
      throw new TotalBaseError("IDEMPOTENCY_KEY_REQUIRED", "This operation requires an Idempotency-Key header.");
    }
    return fn();
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
    throw new TotalBaseError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1-255 characters of [A-Za-z0-9_.-].");
  }

  const { type, id } = dataPrincipal.principal;
  if ((type !== "USER" && type !== "API_KEY") || id === null) {
    // resolveDataPrincipal() only ever produces USER/API_KEY with a real id;
    // this branch exists solely to satisfy Principal's broader union type.
    return fn();
  }

  return context.idempotency.run(
    { principalType: type, principal: id, operationScope, key: rawKey },
    method,
    body,
    fn,
  );
}
