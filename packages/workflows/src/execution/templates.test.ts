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
});
