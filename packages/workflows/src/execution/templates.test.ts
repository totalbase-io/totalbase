import { describe, expect, it } from "vitest";
import type { RunState } from "./bindings.js";
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
