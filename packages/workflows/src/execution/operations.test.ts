import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, describe, expect, it } from "vitest";
import { OPERATION_CATALOG } from "@totalbase/tb-catalog";
import { flattenTemplateData, renderMailingTemplate } from "./email-handlers.js";
import { OPERATION_HANDLERS } from "./handlers.js";
import { isAddressAllowed, outboundPolicy } from "./http-client.js";
import type { RunState } from "./bindings.js";
import { resolveTemplates } from "./templates.js";
import { toRunResult } from "./engine.js";
import type { HandlerArgs } from "./types.js";

// Condition, Validate data and Select case match `_like`/`_regex` in PostgreSQL (filter-evaluator.ts matchPatterns).
const database = new Database(loadDatabaseConfigFromEnv());
afterAll(() => database.close());

describe("HTTP request outbound policy", () => {
  const none = outboundPolicy([]);

  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1",
  ])("refuses %s", (address) => {
    expect(isAddressAllowed(address, none)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(isAddressAllowed(address, none)).toBe(true);
  });

  it("exempts listed addresses and CIDR ranges, and records hostnames", () => {
    const policy = outboundPolicy(["10.0.0.0/8", "127.0.0.1", "Internal.Example"]);
    expect(isAddressAllowed("10.9.9.9", policy)).toBe(true);
    expect(isAddressAllowed("127.0.0.1", policy)).toBe(true);
    expect(isAddressAllowed("127.0.0.2", policy)).toBe(false);
    expect(policy.hostnames.has("internal.example")).toBe(true);
  });
});

describe("Validate data", () => {
  const triggerData = { email: "a@example.com", total: 0 };
  const state = { triggerData, results: new Map(), resultsByKey: new Map([["start", { data: triggerData }]]) } as RunState;
  // The engine resolves the configuration's {{...}} templates before the handler runs (TEMPLATED_OPERATION_TYPES).
  const validate = (configuration: Record<string, unknown>) =>
    OPERATION_HANDLERS["totalbase.validate-data"]!({ context: { database }, configuration: resolveTemplates(configuration, state), state } as unknown as HandlerArgs);

  it("passes the input on next when every rule holds", async () => {
    await expect(validate({ input: { a: 1 }, rules: [{ filter: { a: { _eq: "1" } }, message: "a must be 1" }] }))
      .resolves.toEqual({ output: "next", result: { a: 1 } });
  });

  it("resolves {{...}} templates and lists every failed rule", async () => {
    await expect(validate({
      input: "{{start.data}}",
      rules: [
        { filter: { email: { _nnull: true } }, message: "Email is required." },
        { filter: { total: { _gt: "0" } }, message: "Total must be positive." },
        { filter: { email: { _ilike: "%@other.com" } } },
      ],
    })).rejects.toMatchObject({ code: "WORKFLOW_VALIDATION_FAILED", message: "Validation failed: Total must be positive.; Rule 3 failed." });
  });

  it("rejects rules that are not a list", async () => {
    await expect(validate({ input: {}, rules: { a: { _eq: "1" } } })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN" });
  });
});

describe("MAILING template rendering", () => {
  it("flattens data into dotted variables", () => {
    expect(flattenTemplateData({ customer: { name: "Ana", tags: ["a"] }, total: 3, none: null })).toEqual({
      customer: JSON.stringify({ name: "Ana", tags: ["a"] }), "customer.name": "Ana", "customer.tags": '["a"]', total: "3",
    });
  });

  it("fills subject and message, escaping the message only", () => {
    expect(renderMailingTemplate({ subject: "Hi {{name}}", message: "<p>{{ name }}</p>" }, { name: "<A&B>" }))
      .toEqual({ subject: "Hi <A&B>", html: "<p>&lt;A&amp;B&gt;</p>" });
  });

  it("fails with MISSING_TEMPLATE_VARIABLES instead of rendering a blank", () => {
    expect(() => renderMailingTemplate({ subject: "{{a}}", message: "{{b.c}}" }, { a: "x" })).toThrow(expect.objectContaining({ code: "MISSING_TEMPLATE_VARIABLES" }));
  });
});

/**
 * A filter field's {{...}} is a value (Workflows.md §4.3): a trigger carrying "$ROW.id" made `id = {{...}}` read
 * `id = id` - every row - and a Condition compare a field with itself. The engine resolves a step's filter fields
 * as below (the catalog's filterTemplates).
 */
describe("a carried value in a filter is never the filter grammar", () => {
  const triggerData = { id: "$ROW.id", other: "$ROW.owner", ids: "1,2", owner: 5 };
  const state = { triggerData, results: new Map(), resultsByKey: new Map([["start", { data: triggerData }]]) } as RunState;
  const resolveLikeTheEngine = (type: string, configuration: Record<string, unknown>) => {
    const resolved = resolveTemplates(configuration, state) as Record<string, unknown>;
    for (const field of OPERATION_CATALOG.find((definition) => definition.type === type)?.filterTemplates ?? []) {
      if (configuration[field] !== undefined) resolved[field] = resolveTemplates(configuration[field], state, { filter: true });
    }
    return resolved;
  };
  const run = (type: string, configuration: Record<string, unknown>) =>
    OPERATION_HANDLERS[type]!({ context: { database }, configuration: resolveLikeTheEngine(type, configuration), state } as unknown as HandlerArgs);
  const input = { id: 1, owner: 1 };

  it("Condition compares with the carried text", async () => {
    await expect(run("totalbase.condition", { input, filter: { id: { _eq: "{{start.data.id}}" } } })).resolves.toMatchObject({ output: "false" });
    await expect(run("totalbase.condition", { input, filter: { _or: [{ id: { _in: "{{start.data.ids}}" } }] } })).resolves.toMatchObject({ output: "false" });
    await expect(run("totalbase.condition", { input: { id: "$ROW.id" }, filter: { id: { _eq: "{{start.data.id}}" } } })).resolves.toMatchObject({ output: "true" });
  });

  it("Validate data and Select case do too", async () => {
    await expect(run("totalbase.validate-data", { input, rules: [{ filter: { owner: { _eq: "{{start.data.other}}" } }, message: "Not the owner." }] }))
      .rejects.toMatchObject({ code: "WORKFLOW_VALIDATION_FAILED", message: "Validation failed: Not the owner." });
    await expect(run("totalbase.select-case", { input, hasDefault: true, cases: [{ output: "mine", filter: { owner: { _eq: "{{start.data.other}}" } } }] }))
      .resolves.toMatchObject({ output: "default" });
  });

  it("the author's own $ text stays the grammar", async () => {
    await expect(run("totalbase.condition", { input, filter: { id: { _eq: "$ROW.owner" } } })).resolves.toMatchObject({ output: "true" });
  });

  it("every operation whose configuration holds a filter or a query lists the field in filterTemplates", () => {
    const filterBearing: Record<string, string[]> = {
      "totalbase.read-records": ["query"], "totalbase.update-records": ["where"], "totalbase.delete-records": ["where"],
      "totalbase.condition": ["filter"], "totalbase.validate-data": ["rules"], "totalbase.select-case": ["cases"],
    };
    const declared = Object.fromEntries(OPERATION_CATALOG.filter((definition) => definition.filterTemplates).map((definition) => [definition.type, [...definition.filterTemplates!]]));
    expect(declared).toEqual(filterBearing);
  });
});

// Security regression (Workflows.md §13.1): a run's live error reached its caller - an anonymous webhook sender
// included - with its detail: an HTTP step's URL, upstream headers and body, PostgreSQL's diagnostics.
describe("what a run's caller gets of its error", () => {
  const result = (error: unknown) => toRunResult({ id: "r", status: "FAILED", result: null, error } as Parameters<typeof toRunResult>[0]).error;

  it("keeps what the author wrote: a Finish with error's own code and message, and Validate data's rules", () => {
    expect(result({ code: "ORDER_NOT_FOUND", message: "No such order." })).toEqual({ code: "ORDER_NOT_FOUND", message: "No such order." });
    expect(result({ code: "WORKFLOW_FINISHED_WITH_ERROR", message: "Stopped." })).toEqual({ code: "WORKFLOW_FINISHED_WITH_ERROR", message: "Stopped." });
    const validation = { code: "WORKFLOW_VALIDATION_FAILED", message: "Validation failed: Email is required.", detail: [{ rule: 1, message: "Email is required." }] };
    expect(result(validation)).toEqual(validation);
  });

  it("gives the code alone of everything else, never its message or detail", () => {
    const upstream = { code: "INTERNAL_ERROR", message: "HTTP request returned status 500 from https://api.example.com/?key=secret", detail: { headers: { "set-cookie": "s=1" }, body: "boom" } };
    expect(result(upstream)).toEqual({ code: "INTERNAL_ERROR", message: "The workflow failed. Its run history has the details." });
    expect(result({ code: "UNDEFINED_TABLE", message: 'relation "payroll" does not exist' })).toEqual({ code: "UNDEFINED_TABLE", message: "The workflow failed. Its run history has the details." });
    expect(result(null)).toBeNull();
  });
});
