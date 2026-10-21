import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { resolveDataPrincipalForConfiguredUser, runWorkflow, toRunResult, type WorkflowRunOutcome, type WorkflowRunRecord } from "@totalbase/workflows";
import type { AppContext } from "../context.js";
import { extractBearerToken } from "../auth-guards.js";
import { resolveDataPrincipal, type DataPrincipal } from "../data-principal.js";

interface DefinitionOperation {
  id: string;
  type: string;
  configuration: Record<string, unknown>;
}

/**
 * Fixed 60 requests/IP/minute for PUBLIC webhook admission (specs/
 * Workflows.md §13.2) - a dedicated limiter, not
 * the general `security.rate_limit_*` settings (hardening.ts), which
 * govern the rest of the API and could be turned off or configured to a
 * different number entirely; this one is a mandatory, non-configurable
 * part of exposing an anonymous public endpoint at all. Same in-memory
 * fixed-window shape as `hardening.ts`'s own `RateLimiter` - not shared
 * with it, since sharing state would let ordinary API traffic and public
 * webhook traffic from the same IP starve each other's budget.
 */
class PublicWebhookRateLimiter {
  private static readonly LIMIT = 60;
  private static readonly WINDOW_MS = 60_000;
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  consume(ip: string, now = Date.now()): boolean {
    const existing = this.windows.get(ip);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(ip, { count: 1, resetAt: now + PublicWebhookRateLimiter.WINDOW_MS });
      return true;
    }
    if (existing.count >= PublicWebhookRateLimiter.LIMIT) return false;
    existing.count += 1;
    return true;
  }

  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

const SYNC_TIMEOUT = Symbol("sync-timeout");

/**
 * The WEBHOOK trigger's public HTTP surface (Workflows.md §13.2):
 * `GET|POST /api/workflows/{slug}/webhook`. A workflow-authored
 * `access: PUBLIC|AUTHENTICATED` choice and `response_mode: SYNC|ASYNC`
 * choice on its own Start operation drive everything below - there is no
 * separate route per mode, one handler branches on the resolved
 * workflow's own configuration.
 */
export function registerWorkflowWebhookRoutes(app: FastifyInstance, context: AppContext): void {
  const rateLimiter = new PublicWebhookRateLimiter();
  const sweepInterval = setInterval(() => rateLimiter.sweep(), 60_000);
  sweepInterval.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweepInterval);
    done();
  });

  const handler = async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    const found = await context.workflowsAdmin.getEnabledPublishedBySlug(request.params.slug);
    // Same "don't leak whether a disabled/nonexistent workflow merely
    // exists" reasoning runWorkflowManual's own doc comment already
    // established for the production MANUAL run route.
    if (!found) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "This webhook is not available.");
    const { workflow, definition } = found;
    const start = ((definition.operations as DefinitionOperation[] | undefined) ?? []).find((op) => op.type === "totalbase.start");
    const config = start?.configuration ?? {};
    if (config.trigger !== "WEBHOOK") throw new TotalBaseError("WORKFLOW_NOT_FOUND", "This webhook is not available.");

    const method = (config.method as "GET" | "POST" | undefined) ?? "POST";
    if (request.method !== method) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "This webhook is not available.");

    const access = (config.access as "PUBLIC" | "AUTHENTICATED" | undefined) ?? "PUBLIC";
    let executor: DataPrincipal;
    let initiator: unknown;
    if (access === "PUBLIC") {
      // "Public webhooks ignore any presented credentials for identity
      // selection" - the Authorization header, if any, is never even read.
      if (!rateLimiter.consume(request.ip)) {
        throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many requests. Please slow down.");
      }
      const executeAs = config.execute_as as string | undefined;
      if (!executeAs) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This webhook has no execution user configured.");
      executor = await resolveDataPrincipalForConfiguredUser(context, executeAs);
      initiator = { type: "WEBHOOK", public: true };
    } else {
      const token = extractBearerToken(request);
      const caller = await resolveDataPrincipal(context, token);
      const decision = await context.workflowPermissions.resolveInvoke(caller.roleIds, workflow.id);
      if (decision !== "ALLOW") throw new TotalBaseError("ACTION_DENIED", "INVOKE is not authorized for this workflow.");
      // "Optional - defaults to the authenticated caller when left unset" (WorkflowTriggerFields.vue's own description).
      const executeAsOverride = config.execute_as as string | undefined;
      executor = executeAsOverride ? await resolveDataPrincipalForConfiguredUser(context, executeAsOverride) : caller;
      initiator = { type: caller.principal.type, id: caller.principal.id };
    }

    const body = request.method === "POST" ? (request.body ?? null) : null;
    if (body !== null && (typeof body !== "object" || body === undefined)) {
      throw new TotalBaseError("WORKFLOW_WEBHOOK_INVALID_PAYLOAD", "Webhook body must be a JSON object or array.");
    }
    // "Query parameters remain string values or string arrays" - qs.parse
    // (server.ts's own querystringParser) already produces exactly that
    // shape, so this is a pass-through, not a re-parse.
    //
    // `meta.headers`/`meta.ip` (agreed with the user): a webhook caller
    // legitimately needs to hand the workflow its own headers - an
    // idempotency key, a correlation id, a bearer token meant for a
    // downstream call the workflow itself makes - so this is every header
    // Fastify parsed, unfiltered, not an allowlist. The one safety net is
    // already in place elsewhere: `history-sanitizer.ts`'s own
    // `SENSITIVE_KEY_PATTERN` (password/secret/token/authorization/
    // cookie/api_key) redacts a matching header key to `[REDACTED]`
    // before it's ever PERSISTED to DETAILED history - it does NOT stop
    // this run's own steps from reading/using the real value live (e.g.
    // forwarding an inbound `Authorization` to an outbound HTTP request
    // step) - same "workflow authorship already has this trust level"
    // reasoning already applied to Execute SQL/Execute JavaScript. They
    // never come back to the caller either: a SYNC response is the run's
    // outcome only, not its steps (Workflows.md §13.2).
    // Deliberately WEBHOOK-only - the internal `/api/workflows/{slug}/run`
    // route already carries a real authenticated `initiator`, so caller
    // metadata there is far lower value and was left out.
    const triggerInput = { query: request.query as Record<string, string | string[]>, body, meta: { ip: request.ip, headers: request.headers } };

    const cancelToken = { cancelled: false };
    let resolveAdmitted!: (run: WorkflowRunRecord) => void;
    const admittedPromise = new Promise<WorkflowRunRecord>((resolve) => {
      resolveAdmitted = resolve;
    });
    const runPromise = runWorkflow(
      context,
      executor,
      workflow,
      workflow.publishedVersion!,
      definition,
      { trigger: "WEBHOOK", mode: "PRODUCTION", initiator },
      triggerInput,
      { onAdmitted: resolveAdmitted, cancelToken },
    );
    // Runs to completion regardless of what this request ends up doing
    // below (ASYNC returns immediately; SYNC may time out while this
    // keeps going) - logged here so a background failure is never silent.
    runPromise.catch((error) => context.logger.error({ error, workflowId: workflow.id }, "webhook-triggered run failed"));

    const run = await admittedPromise;
    const responseMode = (config.response_mode as "SYNC" | "ASYNC" | undefined) ?? "SYNC";
    if (responseMode === "ASYNC") {
      // "Asynchronous public callers get the accepted run UUID only for
      // support correlation, not as a credential" - true for authenticated
      // ASYNC callers too, same minimal shape either way.
      reply.code(202);
      return { data: { run: run.id } };
    }

    const timeoutAction = (config.timeout_action as "CONTINUE" | "CANCEL" | undefined) ?? "CONTINUE";
    const configuredWaitSeconds = (config.wait_seconds as number | undefined) ?? 0;
    const maxSyncWaitMs = await context.settings.get("workflows.max_sync_wait_ms");
    // "A workflow value of 0 selects this maximum" (Workflows.md §8.5) - and
    // the server never honors a configured wait longer than that maximum
    // either, regardless of what a workflow's own draft was saved with.
    const effectiveWaitMs = configuredWaitSeconds > 0 ? Math.min(configuredWaitSeconds * 1000, maxSyncWaitMs) : maxSyncWaitMs;

    const outcome = await Promise.race([
      runPromise,
      new Promise<typeof SYNC_TIMEOUT>((resolve) => setTimeout(() => resolve(SYNC_TIMEOUT), effectiveWaitMs)),
    ]);

    if (outcome === SYNC_TIMEOUT) {
      // CONTINUE: `runPromise` above is already running independently of
      // this response and needs nothing further. CANCEL: cooperative -
      // the next step boundary inside engine.ts's `walk()` observes this
      // and stops starting further work (Workflows.md §8.5). A client
      // disconnect never sets this - only an explicit CANCEL timeout
      // action does (Workflows.md §13.2: "a client disconnect is treated as
      // Continue because it does not prove the caller asked to cancel").
      if (timeoutAction === "CANCEL") cancelToken.cancelled = true;
      reply.code(504);
      return {
        errors: [new TotalBaseError("WORKFLOW_SYNC_TIMEOUT", "The workflow did not finish within the configured wait time.").toPublicJSON()],
        meta: { run: run.id },
      };
    }

    // The outcome only, never the steps (their live inputs/results and this
    // request's own headers): the workflow author decides what a caller
    // gets through the Finish step's result (Workflows.md §13.2).
    return { data: toRunResult((outcome as WorkflowRunOutcome).run) };
  };

  app.get("/api/workflows/:slug/webhook", handler);
  app.post("/api/workflows/:slug/webhook", handler);

  /**
   * "An authenticated initiator may retrieve the final result of its own
   * run through the workflow-run result endpoint for 24 hours"
   * (Workflows.md §13.3) - rechecks identity and the invocation grant on every call
   * rather than trusting a knowable UUID, and returns only status/result/
   * error, never the full step history (that stays admin-only, via
   * whatever history surface exists for that - "it never returns detailed
   * history merely because a caller knows a UUID").
   */
  app.get<{ Params: { runId: string } }>("/api/workflows/runs/:runId/result", async (request) => {
    const token = extractBearerToken(request);
    const caller = await resolveDataPrincipal(context, token);
    const run = await context.workflowRuns.getRun(request.params.runId).catch(() => undefined);
    const initiator = run?.initiator as { type?: string; id?: string } | null;
    const isOwnRun = !!initiator && initiator.type === caller.principal.type && initiator.id === caller.principal.id;
    // Still running (an async run being polled), or finished within the last 24 hours.
    const withinWindow = !!run && (!run.finishedAt || Date.now() - run.finishedAt.getTime() <= 24 * 60 * 60 * 1000);
    // A single not-found style rejection either way - existence of
    // someone else's run/an expired run is not information a caller who
    // merely knows (or guesses) a UUID should get to distinguish.
    if (!run || !isOwnRun || !withinWindow) {
      throw new TotalBaseError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found.");
    }
    const decision = await context.workflowPermissions.resolveInvoke(caller.roleIds, run.workflow);
    if (decision !== "ALLOW") throw new TotalBaseError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found.");
    return { data: toRunResult(run) };
  });
}
