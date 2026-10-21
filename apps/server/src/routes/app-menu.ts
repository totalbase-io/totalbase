import type { FastifyInstance } from "fastify";
import { callerRoles } from "../caller-roles.js";
import { pruneMenu, type MenuInput, type MenuObject } from "@totalbase/app-menu";
import type { AdminDashboard } from "@totalbase/dashboards";
import type { AdminDataView } from "@totalbase/dataviews";
import type { AppContext } from "../context.js";
import { requireAdmin, requireAppAccess } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, object, ok, ref } from "../openapi-admin-docs.js";
import { APP_MENU_SCHEMAS } from "../openapi-admin-docs-dataviews.js";
import { listableDataViews } from "./app-dataviews.js";
import { requestData, type DataBody } from "../request-body.js";

function dataviewObject(view: AdminDataView): MenuObject {
  return { kind: "DATAVIEW", id: view.id, name: view.name, slug: view.slug, menuLabel: view.menuLabel, description: view.description, icon: view.icon, color: view.color, viewType: view.viewType };
}
function dashboardObject(dashboard: AdminDashboard): MenuObject {
  return { kind: "DASHBOARD", id: dashboard.id, name: dashboard.name, slug: dashboard.slug, menuLabel: dashboard.menuLabel, description: dashboard.description, icon: dashboard.icon, color: dashboard.color, viewType: null };
}

/** Every published object the menu can show - LISTED DataViews and Dashboards with at least one version. */
async function publishedObjects(context: AppContext): Promise<{ dataviews: AdminDataView[]; objects: MenuObject[] }> {
  const [dataviews, dashboards] = await Promise.all([context.dataviewsAdmin.listPublished(), context.dashboardsAdmin.listPublished(null)]);
  return { dataviews, objects: [...dataviews.map(dataviewObject), ...dashboards.map(dashboardObject)] };
}

/** Published objects kept out of the menu (`EMBEDDED_ONLY`) that could be shown in it - the editor's Hidden section. */
async function hiddenObjects(context: AppContext): Promise<MenuObject[]> {
  const [dataviews, dashboards] = await Promise.all([context.dataviewsAdmin.listHiddenFromMenu(), context.dashboardsAdmin.listHiddenFromMenu()]);
  return [...dataviews.map(dataviewObject), ...dashboards.map(dashboardObject)];
}

/** The administrator's view of the menu: the whole arrangement, plus what is hidden from it. */
async function adminMenu(context: AppContext) {
  const [{ objects }, hidden, mode, groupsOpen, search] = await Promise.all([publishedObjects(context), hiddenObjects(context), menuMode(context), menuGroupsOpen(context), menuSearch(context)]);
  return { mode, groupsOpen, search, nodes: await context.appMenu.tree(objects), hidden };
}

async function menuMode(context: AppContext): Promise<"TREE" | "SIDEBAR"> {
  return (await context.settings.get("app.menu_mode")) === "SIDEBAR" ? "SIDEBAR" : "TREE";
}

/** Whether the menu offers its search box (app.menu_search) - AUTO: past 15 entries the viewer sees (Security.md §8.2). */
async function menuSearch(context: AppContext): Promise<"AUTO" | "ALWAYS" | "NEVER"> {
  return context.settings.get("app.menu_search");
}

/** How the tree menu's groups start (app.menu_groups_open) - a group's own openState overrides it. */
async function menuGroupsOpen(context: AppContext): Promise<"CURRENT" | "OPEN" | "CLOSED"> {
  return context.settings.get("app.menu_groups_open");
}


/** Where the App opens for the caller (Security.md §8.1): their first role's home, by role name, that they see in the menu. */
async function homeOf(context: AppContext, roleIds: string[], objects: MenuObject[], visible: (object: MenuObject) => boolean): Promise<{ kind: MenuObject["kind"]; slug: string } | null> {
  for (const home of await context.roles.homes(roleIds)) {
    const object = objects.find((candidate) => candidate.kind === home.kind && candidate.id === home.id);
    if (object && visible(object)) return { kind: object.kind, slug: object.slug };
  }
  return null;
}

/**
 * The App menu (Security.md §8). Viewers get it
 * filtered through both access levels - a DataView needs its object
 * access and READ on its source, a Dashboard its object access; the
 * administrator reads and replaces the whole arrangement.
 */
export function registerAppMenuRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/app/api/menu", { preHandler: requireAppAccess(context) }, async (request) => {
    const { dataviews, objects } = await publishedObjects(context);
    const nodes = await context.appMenu.tree(objects);
    const { roleIds, administrator } = await callerRoles(context, request);
    if (administrator) {
      return { data: { mode: await menuMode(context), groupsOpen: await menuGroupsOpen(context), search: await menuSearch(context), nodes, home: await homeOf(context, roleIds, objects, () => true) } };
    }

    const [openableDataviews, openableDashboards] = await Promise.all([
      listableDataViews(context, roleIds, dataviews),
      context.dashboardsAdmin.listPublished(roleIds),
    ]);
    const visible = new Set([
      ...openableDataviews.map((view) => `DATAVIEW:${view.id}`),
      ...openableDashboards.map((dashboard) => `DASHBOARD:${dashboard.id}`),
    ]);
    return {
      data: {
        mode: await menuMode(context),
        groupsOpen: await menuGroupsOpen(context),
        search: await menuSearch(context),
        nodes: pruneMenu(nodes, (kind, id) => visible.has(`${kind}:${id}`)),
        home: await homeOf(context, roleIds, objects, (object) => visible.has(`${object.kind}:${object.id}`)),
      },
    };
  });

  const adminPreHandler = requireAdmin(context);

  app.get("/admin/api/app/menu", {
    preHandler: adminPreHandler,
    ...adminDoc("app-menu", {
      summary: "Get the App menu",
      description:
        "The whole arrangement, unfiltered - every published LISTED DataView and Dashboard (viewers get it pruned through " +
        "/app/api/menu) - and `hidden`: the published EMBEDDED_ONLY ones that could be shown (a Detail's own DataView never is). " +
        "Hiding or showing one is its `scope` (PATCH /admin/api/dataviews/{id} or /admin/api/dashboards/{id}).",
      response: ok(ref("AdminAppMenu")),
      schemas: APP_MENU_SCHEMAS,
    }),
  }, async () => ({ data: await adminMenu(context) }));

  app.put<{ Body: DataBody<{ nodes: MenuInput[] }> }>("/admin/api/app/menu", {
    preHandler: adminPreHandler,
    ...adminDoc("app-menu", {
      summary: "Replace the App menu arrangement",
      description:
        "Replaces the whole stored arrangement in one transaction: groups (keep an existing group's `id`, omit it for a new " +
        "one) nesting up to 8 levels, and items by object id. An unknown object or one placed twice is refused by PostgreSQL " +
        "(409); published objects left out are appended to the root on read. Returns the resulting menu.",
      requestBody: { schema: dataEnvelope(object({ nodes: arrayOf(ref("AppMenuInput")) }, ["nodes"])) },
      response: ok(ref("AdminAppMenu")),
      schemas: APP_MENU_SCHEMAS,
    }),
  }, async (request) => {
    await context.appMenu.setArrangement(requestData(request.body).nodes);
    return { data: await adminMenu(context) };
  });
}
