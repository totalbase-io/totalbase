import { createHmac, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { AppMenuService } from "@totalbase/app-menu";
import { AuthProvidersService, AuthService, OAuthService, SmtpEmailSender, type EmailSender } from "@totalbase/auth";
import { AuditExclusionsService, AuditInsightsService, AuditQueryService, AuditService } from "@totalbase/audit";
import { BackupsService } from "@totalbase/backups";
import { DashboardEmbedsService, DashboardsAdminService, embedPreviewKey } from "@totalbase/dashboards";
import { postgresClientEnv, type Database } from "@totalbase/database";
import { SYSTEM_PRINCIPAL } from "@totalbase/shared";
import { DataViewsAdminService, DataViewsStatesService } from "@totalbase/dataviews";
import { ExecutionsService, ExecutionsWorker, MAINTENANCE_EXECUTION_TYPE, MaintenanceService, type Executor } from "@totalbase/executions";
import { FilesAdminService, FilesStorage, FilesTransformService, FoldersAdminService, S3Connection } from "@totalbase/files";
import { IdempotencyService } from "@totalbase/idempotency";
import { EffectivePermissionService, PermissionsService, RoleAssignmentsService, RolesService, WorkflowPermissionService } from "@totalbase/permissions";
import { UsersApisService } from "@totalbase/users-apis";
import { ResourcesAdminService } from "@totalbase/resources";
import { IndexService, RelationDropService, TableSchemaService } from "@totalbase/schema";
import { decryptSecret, encryptSecret, SecretsService } from "@totalbase/secrets";
import { SettingsService } from "@totalbase/settings";
import { SqlConsoleService } from "@totalbase/sql-console";
import { TemplatesAdminService } from "@totalbase/templates";
import { WorkflowRunsService, WorkflowsAdminService, dispatchDataEvent, invokeSubWorkflow, type WorkflowRunOutcome } from "@totalbase/workflows";
import type pino from "pino";
import type { MasterKeyOrigin } from "./master-key.js";
import type { SetupState } from "./setup.js";
import { TOTALBASE_VERSION } from "./version.js";
import { CapabilityPermissionService } from "@totalbase/mutations";
import type { DataPrincipal } from "./data-principal.js";
import { OpenApiDocumentCache } from "./openapi-cache.js";
import { createDataEventQueue } from "./data-event-queue.js";
import { runMaintenanceExecution } from "./maintenance-executor.js";
import { registerAsyncCallExecutors } from "./async-calls.js";

/**
 * Composition root: every service apps/server depends on is built and
 * wired here, explicitly (AGENTS.md section 6: "No DI framework").
 */
export interface AppContext {
  database: Database;
  logger: pino.Logger;
  /** Signs a dashboard widget's file links (D14) - derived from TOTALBASE_MASTER_KEY, never stored. */
  dashboardFilesKey: Buffer;
  /** Signs a backup's download link (Administration.md §12.4) - derived from the master key, never stored. */
  backupDownloadKey: Buffer;
  /** TOTALBASE_PUBLIC_URL - this instance's externally-reachable origin. See buildContext's doc comment. */
  publicUrl: string;
  /** NODE_ENV (env.ts's nodeEnv) - surfaced to the Admin UI (GET /auth/me) so it can show an environment badge in the navbar. */
  nodeEnv: string;
  settings: SettingsService;
  auth: AuthService;
  authProviders: AuthProvidersService;
  oauth: OAuthService;
  usersApis: UsersApisService;
  roles: RolesService;
  roleAssignments: RoleAssignmentsService;
  effectivePermissions: EffectivePermissionService;
  /** Where the master key comes from (Foundations.md §15) - the variable, or a file in the data directory. Never the key. */
  masterKeyOrigin: MasterKeyOrigin;
  /** The first-start setup's code while the instance has no administrator (setup.ts). */
  setup: SetupState;
  audit: AuditService;
  auditExclusions: AuditExclusionsService;
  auditQuery: AuditQueryService;
  auditInsights: AuditInsightsService;
  permissions: PermissionsService;
  workflowPermissions: WorkflowPermissionService;
  resourcesAdmin: ResourcesAdminService;
  dataviewsAdmin: DataViewsAdminService;
  dataviewsStates: DataViewsStatesService;
  dashboardsAdmin: DashboardsAdminService;
  /** A dashboard's embeds - public links and signed embeds (Dashboards.md §9.5). */
  dashboardEmbeds: DashboardEmbedsService;
  /** Signs an administrator's embed previews - derived from the master key, never stored. */
  embedPreviewKey: string;
  appMenu: AppMenuService;
  tableSchema: TableSchemaService;
  indexes: IndexService;
  relationDrop: RelationDropService;
  sqlConsole: SqlConsoleService;
  emailSender: EmailSender;
  secrets: SecretsService;
  idempotency: IdempotencyService;
  capabilityPermissions: CapabilityPermissionService;
  executions: ExecutionsService;
  /** The maintenance queue (Settings > Maintenance): VACUUM/ANALYZE/REINDEX as MAINTENANCE executions, one batch at a time. */
  maintenance: MaintenanceService;
  /** type -> handler registry; empty for now - Workflow will register its own execution types here later. */
  executionExecutors: Record<string, Executor>;
  executionsWorker: ExecutionsWorker;
  /** Runs MAINTENANCE executions only (maintenance-executor.ts) - separate from executionsWorker's queue. */
  maintenanceWorker: ExecutionsWorker;
  /** Built-in backups (Administration.md §12) - their worker loop is index.ts's. */
  backups: BackupsService;
  templatesAdmin: TemplatesAdminService;
  workflowsAdmin: WorkflowsAdminService;
  workflowRuns: WorkflowRunsService;
  /** Fire-and-forget: admits DATA_EVENT-triggered runs for one outbox event. See mutation-service.ts's dispatchOutboxEventsEagerly. */
  dispatchWorkflowDataEvent: (outboxEventId: string) => void;
  /** `totalbase.execute-workflow`'s own recursive call - see workflow-execution/execute-workflow.ts's doc comment. Indirected through AppContext (not imported directly by handlers.ts) to avoid a circular import: engine.ts already imports OPERATION_HANDLERS from handlers.ts. */
  invokeSubWorkflow: (params: { callerPrincipal: DataPrincipal; callerWorkflowId: string; ancestry: string[]; targetWorkflowId: string; input: unknown }) => Promise<WorkflowRunOutcome>;
  foldersAdmin: FoldersAdminService;
  filesAdmin: FilesAdminService;
  /** The storage providers from the files.* settings - shared by every FilesAdminService, transactional ones included. */
  filesStorage: FilesStorage;
  /** The S3 storage connection (s3.* settings) - Files' bucket today. */
  s3: S3Connection;
  filesTransform: FilesTransformService;
  openApiCache: OpenApiDocumentCache;
}

/**
 * `masterKey` is TOTALBASE_MASTER_KEY (apps/server/src/env.ts), passed
 * through explicitly rather than read from process.env here - it must
 * never be logged or stored, and threading it as a constructor argument
 * keeps that guarantee visible at every call site instead of hidden
 * behind a global env lookup (TotalBase secrets architecture doc).
 *
 * `publicUrl` (TOTALBASE_PUBLIC_URL) is this instance's own externally-
 * reachable origin - OAuth needs it to build the redirect_uri it hands
 * to a provider, which must be a stable, known-good URL rather than
 * derived from a request's Host header (env.ts's comment on the same).
 */
export function buildContext(database: Database, logger: pino.Logger, masterKey: string, publicUrl: string, nodeEnv: string, masterKeyOrigin: MasterKeyOrigin = { source: "ENV", path: null }, setup: SetupState = { code: null, source: null, file: "" }, dataDir = "/var/lib/totalbase"): AppContext {
  const settings = new SettingsService(database);
  const secrets = new SecretsService(database, masterKey);
  const emailSender = new SmtpEmailSender(settings, secrets);
  const executions = new ExecutionsService(database);
  const maintenance = new MaintenanceService(database, settings);
  const executionExecutors: Record<string, Executor> = {};
  const maintenanceExecutors: Record<string, Executor> = {};

  const templatesAdmin = new TemplatesAdminService(database);
  const s3 = new S3Connection(settings, (key) => secrets.decrypt(key));
  const filesStorage = new FilesStorage(settings, s3);
  const filesTransform = new FilesTransformService(settings, () => filesStorage.current());
  // A stored image's list thumbnail is made in the background (Administration.md §10.8).
  const filesAdmin = new FilesAdminService(database, settings, filesStorage, (file, content) => void filesTransform.warmThumbnail(file, content));
  const audit = new AuditService(settings);
  const backups = new BackupsService({
    database,
    settings,
    s3Store: () => s3.provider("backups"),
    clientEnv: postgresClientEnv,
    pgBinDir: process.env["TOTALBASE_PG_BIN"] || undefined,
    workDir: join(dataDir, "tmp"),
    totalbaseVersion: TOTALBASE_VERSION,
    workerId: `${hostname()}:${process.pid}`,
    // Each backup's life in the audit log (BACKUP): queued, completed or failed, downloaded, deleted.
    onEvent: async ({ event, backup, adminId, requestId }) => {
      const now = new Date();
      await audit.record(database, {
        requestId: requestId ?? randomUUID(),
        principal: adminId ? { type: "ADMIN", id: adminId } : SYSTEM_PRINCIPAL,
        action: "BACKUP",
        status: event === "FAILED" ? "FAILED" : "EXECUTED",
        source: adminId ? "admin" : "system",
        metadata: { event, backup: backup.id, name: backup.name, destination: backup.destination, trigger: backup.trigger, sizeBytes: backup.sizeBytes },
        ...(event === "FAILED" && backup.error ? { error: { code: "BACKUP_FAILED", message: backup.error } } : {}),
        startedAt: now,
        finishedAt: now,
      }).catch((error) => logger.warn({ error }, "backup audit entry not written"));
    },
  });

  const effectivePermissions = new EffectivePermissionService(database);

  const roles = new RolesService(database);
  const roleAssignments = new RoleAssignmentsService(database);
  const authProviders = new AuthProvidersService(database);
  const auth = new AuthService(database, settings, emailSender, {
    publicUrl,
    onBackgroundError: (err, what) => logger.warn({ err }, `Could not send ${what}`),
    masterKey,
    isAdministrator: async (userId) => roles.holdsAdministratorsRole(await roleAssignments.listEffectiveRolesForUser(userId)),
  });
  const oauth = new OAuthService(database, authProviders, secrets, settings, roleAssignments, masterKey, () => auth.mailer.publicUrl(), auth.mfa);
  const resourcesAdmin = new ResourcesAdminService(database);

  // `const` (not `return {`) so `dispatchWorkflowDataEvent`'s own closure
  // below can reference the fully-built context by name - safe because
  // that closure only runs later, well after this object finishes
  // constructing (see its own comment).
  // At most two dispatches at a time (data-event-queue.ts) - a bulk write's
  // events must not take every pooled connection from the API.
  const dataEvents = createDataEventQueue(
    (outboxEventId) =>
      dispatchDataEvent(context, outboxEventId).catch((error) => logger.error({ error, outboxEventId }, "data-event dispatch failed")),
    2,
  );
  const context: AppContext = {
    database,
    dashboardFilesKey: createHmac("sha256", masterKey).update("totalbase:dashboard-files").digest(),
    backupDownloadKey: createHmac("sha256", masterKey).update("totalbase:backup-download").digest(),
    logger,
    publicUrl,
    nodeEnv,
    settings,
    auth,
    authProviders,
    oauth,
    usersApis: new UsersApisService(database, settings, roles, roleAssignments),
    roles,
    roleAssignments,
    effectivePermissions,
    masterKeyOrigin,
    setup,
    audit,
    auditExclusions: new AuditExclusionsService(database),
    auditQuery: new AuditQueryService(database),
    auditInsights: new AuditInsightsService(database),
    permissions: new PermissionsService(database),
    workflowPermissions: new WorkflowPermissionService(database),
    resourcesAdmin,
    dataviewsAdmin: new DataViewsAdminService(database, () => auth.mailer.publicUrl()),
    dataviewsStates: new DataViewsStatesService(database),
    dashboardsAdmin: new DashboardsAdminService(database),
    dashboardEmbeds: new DashboardEmbedsService(database, {
      encrypt: (plaintext) => encryptSecret(masterKey, plaintext),
      decrypt: (ciphertext) => decryptSecret(masterKey, ciphertext),
    }),
    embedPreviewKey: embedPreviewKey(masterKey),
    appMenu: new AppMenuService(database),
    tableSchema: new TableSchemaService(database),
    indexes: new IndexService(database),
    relationDrop: new RelationDropService(database),
    sqlConsole: new SqlConsoleService(database),
    emailSender,
    secrets,
    idempotency: new IdempotencyService(database, settings),
    capabilityPermissions: new CapabilityPermissionService(database),
    executions,
    maintenance,
    executionExecutors,
    executionsWorker: new ExecutionsWorker(database, settings, executionExecutors),
    maintenanceWorker: new ExecutionsWorker(database, settings, maintenanceExecutors),
    backups,
    templatesAdmin,
    workflowsAdmin: new WorkflowsAdminService(database),
    workflowRuns: new WorkflowRunsService(database),
    foldersAdmin: new FoldersAdminService(database),
    filesAdmin,
    filesStorage,
    s3,
    filesTransform,
    openApiCache: new OpenApiDocumentCache(database),
    dispatchWorkflowDataEvent: (outboxEventId: string) => dataEvents.enqueue(outboxEventId),
    invokeSubWorkflow: (params) => invokeSubWorkflow(context, params),
  };
  // Settings > Maintenance's actions get a worker of their own, one table
  // at a time (index.ts): a batch of VACUUMs never competes for the disk
  // with itself, and never holds up the other execution types' queue.
  maintenanceExecutors[MAINTENANCE_EXECUTION_TYPE] = (execution) => runMaintenanceExecution(context, execution);
  // Function calls and transactions sent with `Prefer: respond-async` (Data_API.md §10.4).
  registerAsyncCallExecutors(context);
  return context;
}
