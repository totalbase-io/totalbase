import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AppContext } from "../context.js";
import { adminDoc, arrayOf, object, ok, UUID } from "../openapi-admin-docs.js";
import { versionParam } from "../request-body.js";

type Pillar = "dataviews" | "dashboards" | "workflows";

interface DeletedVersions {
  deleted: number[];
  kept?: { version: number; runs: number }[];
}

const LABEL: Record<Pillar, string> = { dataviews: "DataView", dashboards: "dashboard", workflows: "workflow" };

/**
 * `DELETE /admin/api/<pillar>/:id/versions?before=N` (Foundations.md
 * §13.4): every version before N goes, never the live one. One route per
 * pillar, the same shape; each deletion is audited with the versions it
 * removed.
 */
export function registerDeleteVersionsRoute(
  app: FastifyInstance,
  context: AppContext,
  preHandler: preHandlerHookHandler,
  pillar: Pillar,
  remove: (id: string, before: number) => Promise<DeletedVersions>,
): void {
  app.delete<{ Params: { id: string }; Querystring: { before?: string } }>(
    `/admin/api/${pillar}/:id/versions`,
    {
      preHandler,
      ...adminDoc(pillar, {
        summary: "Delete old versions",
        description:
          `Deletes every version of the ${LABEL[pillar]} numbered below \`before\` - never the live (latest) one, so the next Publish ` +
          "stays latest + 1 and numbers are never reused. A deleted version can't be restored. " +
          (pillar === "workflows"
            ? "A version that still has runs in the history is kept and listed in `kept` (deleting it would delete its runs); once history retention purges them, it can go. "
            : "") +
          "400 INVALID_QUERY when `before` isn't a positive integer.",
        pathParameters: { id: { description: `The ${LABEL[pillar]}'s id.`, schema: UUID } },
        parameters: [{ name: "before", in: "query", required: true, description: "Versions numbered below this one are deleted.", schema: { type: "integer", minimum: 1 } }],
        response: ok(object({
          deleted: arrayOf({ type: "integer" }),
          ...(pillar === "workflows" && { kept: arrayOf(object({ version: { type: "integer" }, runs: { type: "integer" } })) }),
        })),
      }),
    },
    async (request) => {
      const before = versionParam(String(request.query.before ?? ""));
      const startedAt = new Date();
      const result = await remove(request.params.id, before);
      await auditDeletion(context, request, pillar, request.params.id, result, startedAt);
      return { data: result };
    },
  );
}

async function auditDeletion(context: AppContext, request: FastifyRequest, pillar: Pillar, id: string, result: DeletedVersions, startedAt: Date) {
  if (result.deleted.length === 0) return;
  await context.audit.record(context.database, {
    requestId: request.id,
    principal: { type: "ADMIN", id: request.admin!.id },
    action: "DELETE",
    status: "EXECUTED",
    source: "admin",
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { versionsDeleted: { [pillar]: id, versions: result.deleted }, ...(request.adminToken && { token: request.adminToken }) },
    startedAt,
    finishedAt: new Date(),
  });
}
