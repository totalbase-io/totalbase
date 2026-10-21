import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOTALBASE_ERROR_CODES } from "@totalbase/errors";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminClient } from "./admin-client.js";
import { GUIDES, operationReference } from "./guides.js";
import { pagesGuide, widgetsGuide } from "./guides-pages.js";
import { DASHBOARD_WIDGET_TYPES, OPERATION_CATALOG } from "@totalbase/tb-catalog";
import { BUILD, DATA_API, DATAVIEWS, dashboardsGuide, dashboardWidgetSection, ERRORS, FILES, INSTRUCTIONS, MODELING, PERMISSIONS, WORKFLOWS } from "./guides-text.js";
import { createTotalBaseMcpServer } from "./server.js";

/**
 * The guides can't drift from the server they describe: every tool they name
 * is registered, every guide they point at exists, every error code they
 * explain is one TotalBase raises. Nothing here reaches an instance - tools
 * are listed, not called.
 */
const TEXTS = { INSTRUCTIONS, BUILD, MODELING, PERMISSIONS, DATA_API, FILES, DATAVIEWS, DASHBOARDS: dashboardsGuide(), PAGES: pagesGuide(), WIDGETS: widgetsGuide(), WORKFLOWS: `${WORKFLOWS}\n\n${operationReference()}`, ERRORS };

describe("guides", () => {
  let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];

  beforeAll(async () => {
    const server = createTotalBaseMcpServer(new AdminClient({ baseUrl: "http://localhost:0", token: "unused" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "guides-test", version: "1.0.0" });
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
  });

  it("name only tools the server registers", () => {
    const registered = new Set(tools.map((t) => t.name));
    // A tool parameter, an alter_table operation or a stored key may share a tool's shape (expose_methods, create_index,
    // execute_as) - those aren't tool names.
    const parameters = new Set(tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {})));
    const KEYS = new Set(["execute_as", "send_email", "require_where_for_update", "require_where_for_delete", "create_index", "drop_index", "set_primary_key", "list_margin", "set_constraint_message"]);
    const toolShaped = /^(whoami|(list|get|create|update|delete|publish|save|set|grant|revoke|apply|query|write|call|describe|alter|expose|sync|execute|explain|preview|run|send)_[a-z_]+)$/;
    for (const [name, text] of Object.entries(TEXTS)) {
      for (const [, word] of text.matchAll(/(?<![.\w])([a-z]+(?:_[a-z]+)+)\b/g)) {
        if (!toolShaped.test(word!) || parameters.has(word!) || KEYS.has(word!)) continue;
        expect(registered.has(word!), `${name} names "${word}", which isn't a tool`).toBe(true);
      }
    }
  });

  it("explain every step of the operation catalog", () => {
    const steps = WORKFLOWS.slice(WORKFLOWS.indexOf("## Steps"), WORKFLOWS.indexOf("## Lifecycle"));
    for (const { type } of OPERATION_CATALOG) {
      if (type !== "totalbase.start") expect(steps, `the Steps section explains ${type}`).toContain(type);
    }
    for (const { type } of OPERATION_CATALOG) {
      if (type !== "totalbase.start") expect(operationReference()).toContain(`- ${type} - `);
    }
  });

  it("point only at guides that exist", () => {
    const guides = new Set(GUIDES.map((g) => g.name));
    for (const [name, text] of Object.entries(TEXTS)) {
      for (const [, guide] of text.matchAll(/totalbase:\/\/guide\/([a-z-]+)/g)) expect(guides.has(guide!), `${name} points at ${guide}`).toBe(true);
    }
    // The instructions' own list names every guide.
    for (const guide of guides) expect(INSTRUCTIONS).toContain(guide);
  });

  it("explain only error codes TotalBase raises", () => {
    const codes = new Set<string>(TOTALBASE_ERROR_CODES);
    // The codes are each table row's first cell, and the transient list.
    const cells = [...ERRORS.matchAll(/^\| ([^|]+) \|/gm)].map((m) => m[1]!).filter((cell) => cell !== "Code" && !cell.startsWith("---"));
    const transient = ERRORS.slice(ERRORS.indexOf("## Transient")).split("\n").slice(1).join(" ");
    for (const [, code] of [...cells, transient].join(" ").matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g)) {
      expect(codes.has(code!), `ERRORS explains ${code}, which TotalBase doesn't raise`).toBe(true);
    }
  });

  it("annotate every tool, and every destructive one as such", () => {
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
      if (/^(delete_|revoke_)/.test(tool.name)) expect(tool.annotations?.["destructiveHint"], tool.name).toBe(true);
      if (/^(list_|get_|describe_|query_|preview_|explain_)/.test(tool.name) || tool.name === "whoami") expect(tool.annotations?.["readOnlyHint"], tool.name).toBe(true);
    }
  });

  // At 83 KB, every widget type's contract in it, the guide was past what an MCP client reads at once.
  it("keep the dashboards guide short, each widget type's contract read on its own", () => {
    expect(dashboardsGuide().length).toBeLessThan(32_000);
    for (const type of DASHBOARD_WIDGET_TYPES) {
      expect(dashboardsGuide(), type).toContain(`${type} (`);
      expect(dashboardWidgetSection(type), type).toMatch(new RegExp(`^### ${type} - `));
    }
  });
});
