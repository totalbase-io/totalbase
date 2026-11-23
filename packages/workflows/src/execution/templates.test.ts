import { describe, expect, it } from "vitest";
import type { RunState } from "./bindings.js";
import { FilterLiteral } from "@totalbase/query-engine";
import { resolveTemplates } from "./templates.js";

describe("{{...}} templates", () => {
  const triggerData = { customer: { name: "Acme", email: null } };
  const state = {
    triggerData,
    results: new Map(),
    resultsByKey: new Map<string, unknown>([
      ["start", { data: triggerData }],
      ["file", { data: { asset: "f-1", name: "a.pdf", mimeType: "application/pdf", size: 10 } }],
      ["rows", { data: [{ id: 1 }] }],
    ]),
  } as RunState;
  const resolve = (value: unknown) => resolveTemplates(value, state);

  it("resolves a step result's path to its typed value", () => {
    expect(resolve("{{file.data.size}}")).toBe(10);
    expect(resolve("{{rows.data[0].id}}")).toBe(1);
    expect(resolve("{{rows.data.length}}")).toBe(1);
  });

  // A typo in a path wrote NULL into business data and the run succeeded.
  it("fails on a path a step's result doesn't have, naming what it has", () => {
    expect(() => resolve({ set: { pdf: "{{file.data.id}}" } })).toThrow(
      "{{file.data.id}}: file.data has no id - it has asset, name, mimeType, size.",
    );
    expect(() => resolve("Invoice {{file.data.id}}")).toThrow("file.data has no id");
    expect(() => resolve("{{rows.data[3].id}}")).toThrow("rows.data has no [3] - it is a list of 1");
  });

  it("resolves a null on the way to null - the data's own answer", () => {
    expect(resolve("{{start.data.customer.email}}")).toBeNull();
    expect(resolve("{{start.data.customer.email.domain}}")).toBeNull();
  });

  it("leaves a field the trigger's payload left out empty", () => {
    expect(resolve("{{start.data.customer.phone}}")).toBeUndefined();
    expect(resolve("Phone: {{start.data.missing.deeper}}")).toBe("Phone: ");
  });
  // An HTML field (Send email's htmlBody, Workflows.md §5.16): what a trigger carries can't become markup.
  it("escapes a value spliced into HTML, and leaves alone a field that is one expression in full", () => {
    const html = new Map<string, unknown>([
      ["start", { data: { name: "<script>alert(1)</script>", note: `Tom & "Jerry's"`, tags: ["<b>"], count: 3 } }],
      ["build", { data: { html: "<table><tr><td>1</td></tr></table>" } }],
    ]);
    const resolveHtml = (value: unknown) => resolveTemplates(value, { ...state, resultsByKey: html } as RunState, { html: true });

    expect(resolveHtml("<p>Hi {{start.data.name}}</p>")).toBe("<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(resolveHtml("<p>{{start.data.note}} x{{start.data.count}}</p>")).toBe("<p>Tom &amp; &quot;Jerry&#39;s&quot; x3</p>");
    expect(resolveHtml("<p>{{start.data.tags}}</p>")).toBe("<p>[&quot;&lt;b&gt;&quot;]</p>");
    // The body another step built, handed over whole.
    expect(resolveHtml("{{build.data.html}}")).toBe("<table><tr><td>1</td></tr></table>");
    // Without the option nothing changes.
    expect(resolveTemplates("<p>{{start.data.name}}</p>", { ...state, resultsByKey: html } as RunState)).toBe("<p><script>alert(1)</script></p>");
  });
});

describe("{{...}} templates in a filter field", () => {
  const triggerData = { id: "$ROW.id", ids: ["1", "2"] };
  const state = { triggerData, results: new Map(), resultsByKey: new Map([["start", { data: triggerData }]]) } as RunState;
  const resolveFilter = (value: unknown) => resolveTemplates(value, state, { filter: true });

  // A webhook's body choosing an Update/Delete records' rows (security regression, WF-01): a {{...}} outside an
  // operator's value is never the filter's grammar.
  it("refuses a {{...}} that would become the filter's grammar - the whole filter, a field, a logical list", () => {
    const attacker = { where: { reservado: { _eq: false } }, ors: [{ id: { _neq: "x" } }], field: { _neq: "x" }, id: "abc" };
    const hostile = { triggerData: attacker, results: new Map(), resultsByKey: new Map([["start", { data: attacker }]]) } as RunState;
    const resolve = (value: unknown) => resolveTemplates(value, hostile, { filter: true });
    expect(() => resolve("{{start.data.where}}")).toThrow(/resolves to an object/);
    expect(() => resolve({ _or: "{{start.data.ors}}" })).toThrow(/resolves to a list/);
    expect(() => resolve({ id: "{{start.data.field}}" })).toThrow(/resolves to an object/);
    expect(() => resolve({ where: "{{start.data.where}}", limit: 10 })).toThrow(/WORKFLOW_INVALID_DESIGN|resolves to an object/);
    // A value stays a value: an operator's, or a scalar anywhere else (a Read records query's limit).
    expect(resolve({ id: { _eq: "{{start.data.where}}" } })).toEqual({ id: { _eq: expect.any(FilterLiteral) } });
    expect(resolve({ limit: "{{start.data.id}}" })).toEqual({ limit: "abc" });
  });

  it("resolves an operator's templated value to a FilterLiteral, and leaves the author's text as it is", () => {
    const resolved = resolveFilter({ _and: [{ id: { _eq: "{{start.data.id}}" } }, { owner: { _eq: "$USER.id" } }, { tag: { _in: ["{{start.data.id}}", "x"] } }] }) as {
      _and: [{ id: { _eq: FilterLiteral } }, { owner: { _eq: string } }, { tag: { _in: [FilterLiteral, string] } }];
    };
    expect(resolved._and[0].id._eq).toBeInstanceOf(FilterLiteral);
    expect(resolved._and[0].id._eq.value).toBe("$ROW.id");
    expect(resolved._and[1].owner._eq).toBe("$USER.id");
    expect(resolved._and[2].tag._in[0]).toBeInstanceOf(FilterLiteral);
    expect(resolved._and[2].tag._in[1]).toBe("x");
    // Stored as the value it holds.
    expect(JSON.parse(JSON.stringify(resolved))).toEqual({ _and: [{ id: { _eq: "$ROW.id" } }, { owner: { _eq: "$USER.id" } }, { tag: { _in: ["$ROW.id", "x"] } }] });
  });

  it("resolves the rest of the field as anywhere else - a query's clauses, a rule's message", () => {
    expect(resolveFilter({ limit: "{{start.data.ids.length}}", where: { id: { _in: "{{start.data.ids}}" } } })).toEqual({
      limit: 2, where: { id: { _in: new FilterLiteral(["1", "2"]) } },
    });
    expect(resolveFilter([{ message: "Bad {{start.data.id}}", filter: {} }])).toEqual([{ message: "Bad $ROW.id", filter: {} }]);
  });
});
