import pino from "pino";
import { bootstrap, publicUrlFor } from "./bootstrap.js";
import { buildContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { buildServer } from "./server.js";
import { syncCatalog, syncCatalogIfChanged } from "./catalog-refresh.js";
import { getCatalogFingerprint } from "@totalbase/pg-catalog";
import { requeueFailedOutbox, runRetention } from "./retention.js";
import { runCronTick } from "@totalbase/workflows";
import { listenForInvalidations } from "./invalidations.js";

async function main() {
  const env = loadServerEnv();
  const logger = pino({ level: env.logLevel });

  const { database, masterKey, masterKeyOrigin, setup } = await bootstrap(env, logger);
  const context = buildContext(database, logger, masterKey, publicUrlFor(env), env.nodeEnv, masterKeyOrigin, setup, env.dataDir);
  // Before the first request: what another process changes from now on reaches this one (Foundations.md §4.6).
  await listenForInvalidations(context);
  const app = await buildServer(
    context,
    env.logLevel,
    { enabled: env.adminUiEnabled, dir: env.adminUiDir, devProxyTarget: env.adminUiDevProxyTarget },
  );

  await app.listen({ host: env.host, port: env.port });
  logger.info({ host: env.host, port: env.port }, "TotalBase server ready");

  // In-process Executions worker (Data_API.md §10.2:
  // no Redis/RabbitMQ/Kafka required). Recommended over a
  // separate deployable process; every server process runs it, its
  // claims in PostgreSQL (Foundations.md §4.5); see Data_API.md §10.2.
  let pollTimer: NodeJS.Timeout | undefined;
  const scheduleNextPoll = () => {
    context.settings.get("async_executions.poll_interval_ms").then((intervalMs) => {
      pollTimer = setTimeout(async () => {
        try {
          await context.executionsWorker.reclaimStale();
          await context.executionsWorker.processBatch();
        } catch (error) {
          logger.error({ error }, "executions worker poll failed");
        }
        scheduleNextPoll();
      }, intervalMs);
    }).catch((error) => {
      // A settings read that fails (the database away for a moment) never ends the loop: log it and try again later.
      logger.error({ error }, "scheduleNextPoll could not read its interval - retrying");
      setTimeout(() => scheduleNextPoll(), 5000);
    });
  };
  scheduleNextPoll();

  // The maintenance worker (Settings > Maintenance): one table at a time,
  // straight on to the next while a batch has work, otherwise at the
  // same poll interval as the executions queue.
  let maintenanceTimer: NodeJS.Timeout | undefined;
  const scheduleNextMaintenance = (delayMs?: number) => {
    context.settings.get("async_executions.poll_interval_ms").then((intervalMs) => {
      maintenanceTimer = setTimeout(async () => {
        let processed = 0;
        try {
          await context.maintenanceWorker.reclaimStale();
          processed = await context.maintenanceWorker.processBatch(1);
        } catch (error) {
          logger.error({ error }, "maintenance worker poll failed");
        }
        scheduleNextMaintenance(processed > 0 ? 0 : undefined);
      }, delayMs ?? intervalMs);
    }).catch((error) => {
      // A settings read that fails (the database away for a moment) never ends the loop: log it and try again later.
      logger.error({ error }, "scheduleNextMaintenance could not read its interval - retrying");
      setTimeout(() => scheduleNextMaintenance(), 5000);
    });
  };
  scheduleNextMaintenance();

  // Automatic retention, every 6 hours: SQL Console history, then ended
  // sessions (auth.session_retention_days).
  //
  // SQL Console history retention (Administration.md §5.4:
  // sql_console.history_retention_days). A fixed interval is enough here -
  // unlike the executions queue this isn't latency-sensitive, so it
  // doesn't need its own configurable poll_interval setting. The manual
  // "purge before date" action in the admin UI (DELETE /sql/history) uses
  // the same SqlConsoleService.purgeHistory() on demand between cycles.
  const HISTORY_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let historyPurgeTimer: NodeJS.Timeout | undefined;
  const scheduleNextHistoryPurge = () => {
    historyPurgeTimer = setTimeout(async () => {
      try {
        const retentionDays = await context.settings.get("sql_console.history_retention_days");
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const deletedCount = await context.sqlConsole.purgeHistory(cutoff);
        if (deletedCount > 0) logger.info({ deletedCount, retentionDays }, "sql console history purged");
      } catch (error) {
        logger.error({ error }, "sql console history purge failed");
      }
      // Ended sessions (revoked / expired) past auth.session_retention_days.
      try {
        const retentionDays = await context.settings.get("auth.session_retention_days");
        const deletedCount = await context.auth.sessions.purgeEnded(retentionDays);
        if (deletedCount > 0) logger.info({ deletedCount, retentionDays }, "ended sessions purged");
      } catch (error) {
        logger.error({ error }, "ended sessions purge failed");
      }
      scheduleNextHistoryPurge();
    }, HISTORY_PURGE_INTERVAL_MS);
  };
  scheduleNextHistoryPurge();

  // Workflow run maintenance (specs/Workflows.md §8.6, §9.4):
  // fail-closed crash recovery first (an expired PENDING/
  // RUNNING run means its process died - see reclaimExpired's own doc
  // comment), then history retention purge, same fixed-interval shape as
  // the SQL Console history job just above (not latency-sensitive).
  const WORKFLOW_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
  let workflowMaintenanceTimer: NodeJS.Timeout | undefined;
  const scheduleNextWorkflowMaintenance = () => {
    workflowMaintenanceTimer = setTimeout(async () => {
      try {
        const reclaimed = await context.workflowRuns.reclaimExpired();
        if (reclaimed.runs > 0) logger.info(reclaimed, "workflow runs reclaimed (expired lease)");

        const [summaryDays, detailedDays] = await Promise.all([
          context.settings.get("workflows.history_summary_retention_days"),
          context.settings.get("workflows.history_detailed_retention_days"),
        ]);
        const dayMs = 24 * 60 * 60 * 1000;
        const purgedCount = await context.workflowRuns.purgeFinished({
          disabledHistory: new Date(Date.now() - dayMs),
          summary: new Date(Date.now() - summaryDays * dayMs),
          detailed: new Date(Date.now() - detailedDays * dayMs),
        });
        if (purgedCount > 0) logger.info({ purgedCount }, "workflow run history purged");

        // CRON admission claims (workflows_crons) only
        // ever need to outlive the handful of ticks around their own
        // occurrence - a fixed 2-day window, no settings knob, same
        // reasoning as the outbox poll's own fixed interval just below.
        const { rowCount: purgedCronAdmissions } = await context.database.query(
          `DELETE FROM totalbase.workflows_crons WHERE scheduled_at < now() - interval '2 days'`,
        );
        if (purgedCronAdmissions > 0) logger.info({ purgedCronAdmissions }, "cron admission claims purged");

        // The OpenAPI cache's change log (openapi-cache.ts) only needs to
        // move, not to keep history - an hour of rows is plenty.
        await context.database.query(`DELETE FROM totalbase.invalidations WHERE created_at < now() - interval '1 hour'`);
      } catch (error) {
        logger.error({ error }, "workflow run maintenance failed");
      }
      scheduleNextWorkflowMaintenance();
    }, WORKFLOW_MAINTENANCE_INTERVAL_MS);
  };
  scheduleNextWorkflowMaintenance();

  // Retention, hourly (retention.ts): audit log (audit.retention_days),
  // expired idempotency keys, processed outbox events
  // (outbox.retention_days), finished executions
  // (async_executions.retention_days), ended personal access tokens
  // (api_keys.purge_after_days), image derivatives
  // (files.transforms.cache_ttl_seconds, and those of deleted files).
  // Windows are re-read every cycle, so a change applies without a restart.
  const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
  let retentionTimer: NodeJS.Timeout | undefined;
  const scheduleNextRetention = () => {
    retentionTimer = setTimeout(async () => {
      await runRetention(context);
      scheduleNextRetention();
    }, RETENTION_INTERVAL_MS);
  };
  scheduleNextRetention();

  // Outbox fallback poller (mutation-service.ts's dispatchOutboxEventsEagerly
  // already dispatches PENDING rows the instant they're enqueued - this is
  // only the backstop for whatever that misses: a crash between commit and
  // eager dispatch, or a dispatch that itself failed and left the row
  // PENDING again after a retry). Fixed interval, not a configurable
  // setting - same reasoning as the SQL Console history purge job above,
  // just a shorter interval since a stuck DATA_EVENT admission is more
  // user-facing than stale history rows.
  const OUTBOX_POLL_INTERVAL_MS = 10_000;
  let outboxPollTimer: NodeJS.Timeout | undefined;
  const scheduleNextOutboxPoll = () => {
    outboxPollTimer = setTimeout(async () => {
      try {
        // FAILED events whose retry is due go back to PENDING first
        // (outbox.max_attempts / outbox.retry_delay_seconds), then are
        // dispatched like any other pending event.
        await requeueFailedOutbox(context);
        const { rows } = await context.database.query<{ id: string }>(
          `SELECT id FROM totalbase.outbox WHERE status = 'PENDING' AND available_at <= now() ORDER BY available_at ASC LIMIT 100`,
        );
        for (const row of rows) context.dispatchWorkflowDataEvent(row.id);
      } catch (error) {
        logger.error({ error }, "outbox fallback poll failed");
      }
      scheduleNextOutboxPoll();
    }, OUTBOX_POLL_INTERVAL_MS);
  };
  scheduleNextOutboxPoll();

  // CRON trigger scan (specs/Workflows.md §6.4) -
  // ticks every 15s, well under the finest cron granularity (one minute),
  // so a workflow scheduled for a given minute gets several chances to be
  // caught even if one tick runs a little late. Correctness doesn't depend
  // on this exact interval - runCronTick()'s own admission claim (a unique
  // (workflow, scheduled_at) row) makes firing the same occurrence from
  // multiple ticks a no-op, so ticking faster only ever costs a bit more
  // CPU, never a double-run.
  const CRON_POLL_INTERVAL_MS = 15_000;
  let cronPollTimer: NodeJS.Timeout | undefined;
  const scheduleNextCronTick = () => {
    cronPollTimer = setTimeout(async () => {
      try {
        void (await runCronTick(context)); // the runs it admitted keep running on their own (its doc comment)
      } catch (error) {
        logger.error({ error }, "cron tick failed");
      }
      scheduleNextCronTick();
    }, CRON_POLL_INTERVAL_MS);
  };
  scheduleNextCronTick();

  // Built-in backups (Administration.md §12): every 15 s - the schedule's tick (an occurrence queued once,
  // whatever the number of processes), a backup the server stopped in the middle of marked failed, then the
  // queued one run to its end. Never two at once: one is queued or running per instance (backups_one_active).
  const BACKUPS_POLL_INTERVAL_MS = 15_000;
  let backupsTimer: NodeJS.Timeout | undefined;
  const scheduleNextBackupsPoll = () => {
    backupsTimer = setTimeout(async () => {
      try {
        await context.backups.scheduleTick();
        await context.backups.reclaimStale();
        await context.backups.processNext();
      } catch (error) {
        logger.error({ error }, "backups worker poll failed");
      }
      scheduleNextBackupsPoll();
    }, BACKUPS_POLL_INTERVAL_MS);
  };
  scheduleNextBackupsPoll();

  // Scheduled catalog sync (catalog.refresh_interval_minutes): picks up
  // DDL made outside TotalBase - psql, a migration tool - which nothing
  // else would notice. The interval is re-read every cycle, so a change
  // applies without a restart; 0 turns it off (checked again each minute).
  let catalogRefreshTimer: NodeJS.Timeout | undefined;
  const scheduleNextCatalogRefresh = () => {
    context.settings.get("catalog.refresh_interval_minutes").then((minutes) => {
      catalogRefreshTimer = setTimeout(async () => {
        if (minutes > 0) {
          try {
            const result = await syncCatalog(context);
            if (result.discovered + result.reactivated + result.missing + result.purged > 0) logger.info(result, "catalog synced");
          } catch (error) {
            logger.error({ error }, "scheduled catalog sync failed");
          }
        }
        scheduleNextCatalogRefresh();
      }, (minutes > 0 ? minutes : 1) * 60 * 1000);
    }).catch((error) => {
      // A settings read that fails (the database away for a moment) never ends the loop: log it and try again later.
      logger.error({ error }, "scheduleNextCatalogRefresh could not read its interval - retrying");
      setTimeout(() => scheduleNextCatalogRefresh(), 60 * 1000);
    });
  };
  scheduleNextCatalogRefresh();

  // Change watch (catalog.watch_interval_seconds): the same DDL made
  // outside TotalBase, within seconds - a small fingerprint query each
  // tick, a full sync only when it changed. Re-read every cycle like the
  // scheduled sync; 0 turns it off (checked again each minute).
  let catalogWatchTimer: NodeJS.Timeout | undefined;
  let catalogFingerprint = await getCatalogFingerprint(database);
  const scheduleNextCatalogWatch = () => {
    context.settings.get("catalog.watch_interval_seconds").then((seconds) => {
      catalogWatchTimer = setTimeout(async () => {
        if (seconds > 0) {
          try {
            const { fingerprint, result } = await syncCatalogIfChanged(context, catalogFingerprint);
            catalogFingerprint = fingerprint;
            if (result) logger.info(result, "catalog changed - synced");
          } catch (error) {
            logger.error({ error }, "catalog change watch failed");
          }
        }
        scheduleNextCatalogWatch();
      }, (seconds > 0 ? seconds : 60) * 1000);
    }).catch((error) => {
      // A settings read that fails (the database away for a moment) never ends the loop: log it and try again later.
      logger.error({ error }, "scheduleNextCatalogWatch could not read its interval - retrying");
      setTimeout(() => scheduleNextCatalogWatch(), 60 * 1000);
    });
  };
  scheduleNextCatalogWatch();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    if (pollTimer) clearTimeout(pollTimer);
    if (maintenanceTimer) clearTimeout(maintenanceTimer);
    if (backupsTimer) clearTimeout(backupsTimer);
    if (historyPurgeTimer) clearTimeout(historyPurgeTimer);
    if (workflowMaintenanceTimer) clearTimeout(workflowMaintenanceTimer);
    if (retentionTimer) clearTimeout(retentionTimer);
    if (outboxPollTimer) clearTimeout(outboxPollTimer);
    if (cronPollTimer) clearTimeout(cronPollTimer);
    if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
    if (catalogWatchTimer) clearTimeout(catalogWatchTimer);
    await app.close();
    // A notice already being sent (a password changed...) goes out - a few seconds at most, a slow relay can't hold the exit.
    await Promise.race([context.auth.emailsSettled(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await database.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
