import { notify, type Queryable, type Subscription } from "@totalbase/database";
import { relationDetailCache } from "@totalbase/pg-catalog";
import { requestRunCancellation } from "@totalbase/workflows";
import type { AppContext } from "./context.js";

/**
 * Several server processes per instance (Foundations.md §4.6): what one process keeps in memory and another
 * can change, told over PostgreSQL's LISTEN/NOTIFY on one channel. A signal sent inside a transaction leaves
 * at its COMMIT and never on ROLLBACK. Every process - the sender too - applies what it receives; the sender
 * has already applied it locally, and applying it twice only costs a reload.
 *
 * - SETTINGS: a setting changed (a trigger on totalbase.settings sends it, whoever wrote the row); no key = all.
 * - CATALOG: DDL may have changed what was introspected - OpenAPI documents, relation details, widget plans.
 * - RUN_CANCEL: Cancel on a run another process is executing (engine.ts keeps its cancel token in memory).
 * - SETUP: the first administrator exists - the setup code is spent everywhere.
 */
export const INVALIDATIONS_CHANNEL = "totalbase_invalidations";

export type Invalidation =
  | { topic: "SETTINGS"; key?: string }
  | { topic: "CATALOG" }
  | { topic: "RUN_CANCEL"; run: string }
  | { topic: "SETUP" };

/** Sends `invalidation` to every process - on `client`'s transaction when given, so it leaves only if that commits. */
export async function signal(context: Pick<AppContext, "database">, invalidation: Invalidation, client: Queryable = context.database): Promise<void> {
  await notify(client, INVALIDATIONS_CHANNEL, JSON.stringify(invalidation));
}

/** What a CATALOG signal drops, in this process. */
export function forgetCatalog(context: Pick<AppContext, "openApiCache" | "dashboardsAdmin">): void {
  context.openApiCache.invalidate();
  relationDetailCache.clear();
  context.dashboardsAdmin.forgetPlans();
}

/** The catalog may have changed: dropped here at once, and told to every other process. */
export async function catalogChanged(context: Pick<AppContext, "database" | "openApiCache" | "dashboardsAdmin">): Promise<void> {
  forgetCatalog(context);
  await signal(context, { topic: "CATALOG" });
}

/** Applies one received signal to this process's memory. An unknown or malformed one is ignored. */
export function applyInvalidation(context: AppContext, payload: string): void {
  let invalidation: Invalidation;
  try {
    invalidation = JSON.parse(payload) as Invalidation;
  } catch {
    context.logger.warn({ payload }, "invalidation signal is not JSON - ignored");
    return;
  }
  switch (invalidation.topic) {
    case "SETTINGS":
      context.settings.forget(typeof invalidation.key === "string" ? invalidation.key : undefined);
      return;
    case "CATALOG":
      forgetCatalog(context);
      return;
    case "RUN_CANCEL":
      if (typeof invalidation.run === "string") requestRunCancellation(invalidation.run);
      return;
    case "SETUP":
      context.setup.code = null;
      return;
  }
}

/**
 * This process's LISTEN. Back after a lost connection, it can't know what it missed, so it drops everything a
 * signal could have dropped (a cancel missed meanwhile is not recovered: the run goes on and ends on its own).
 */
export function listenForInvalidations(context: AppContext): Promise<Subscription> {
  return context.database.listen(INVALIDATIONS_CHANNEL, {
    onNotification: (payload) => applyInvalidation(context, payload),
    onReconnect: () => {
      context.logger.info("invalidation signal connection restored - in-memory caches dropped");
      context.settings.forget();
      forgetCatalog(context);
    },
    onError: (error) => context.logger.warn({ error }, "invalidation signal connection lost - reconnecting"),
  });
}
