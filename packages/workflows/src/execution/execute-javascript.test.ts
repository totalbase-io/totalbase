import { describe, expect, it } from "vitest";
import type { RunState } from "./bindings.js";
import { CODE_HANDLERS } from "./code-handlers.js";
import type { HandlerArgs } from "./types.js";

const run = (code: string, triggerData: unknown = null, results: Record<string, unknown> = {}, byKey: Record<string, unknown> = {}) =>
  CODE_HANDLERS["totalbase.execute-javascript"]!({
    configuration: { code },
    state: { triggerData, results: new Map(Object.entries(results)), resultsByKey: new Map(Object.entries(byKey)) } as unknown as RunState,
    // The JavaScript step never touches the instance - no context, principal or ancestry needed.
    context: {} as HandlerArgs["context"],
    dataPrincipal: {} as HandlerArgs["dataPrincipal"],
    workflowContext: { workflowId: "test", ancestry: [], runId: "test", stepId: "test", initiator: null },
  });

/**
 * `totalbase.execute-javascript` - author code runs in a fresh isolated-vm
 * isolate: only `trigger` and `results` in scope, no Node globals, 5 s and
 * 32 MiB caps, and a JSON-only result.
 */
describe("Execute JavaScript sandbox", () => {
  it("returns what the script returns, computed from trigger and earlier results", async () => {
    const outcome = await run("return { total: trigger.qty * results.price.data }", { qty: 3 }, { price: { data: 4 } });
    expect(outcome).toEqual({ output: "next", result: { total: 12 } });
  });

  it("reads an earlier step by its key, as templates do, and by its operation id", async () => {
    const people = { data: [{ id: 7, name: "Ana" }] };
    const outcome = await run("return [results.read_people.data[0].name, results['3f1c2d4e-0000-4000-8000-000000000001'].data.length]", null, { "3f1c2d4e-0000-4000-8000-000000000001": people }, { read_people: people });
    expect(outcome.result).toEqual(["Ana", 1]);
  });

  it("has none of Node's globals - no process, require, fetch or filesystem", async () => {
    const outcome = await run(`return {
      process: typeof process, require: typeof require, fetch: typeof fetch,
      globalThisProcess: typeof globalThis.process, module: typeof module, Buffer: typeof Buffer,
    }`);
    expect(outcome.result).toEqual({
      process: "undefined", require: "undefined", fetch: "undefined",
      globalThisProcess: "undefined", module: "undefined", Buffer: "undefined",
    });
  });

  it("offers V8's own globals and URLSearchParams - what Workflows.md §5.8 lists - and nothing of the browser's or Node's", async () => {
    const present = ["JSON", "Math", "Date", "Intl", "String", "Number", "Array", "Object", "RegExp", "Map", "Set", "Promise", "BigInt", "Uint8Array", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "parseInt", "parseFloat", "URLSearchParams"];
    const absent = ["URL", "TextEncoder", "TextDecoder", "atob", "btoa", "setTimeout", "setInterval", "crypto", "fetch", "structuredClone", "console.log"];
    const outcome = await run(`return {
      missing: ${JSON.stringify(present)}.filter((name) => typeof globalThis[name] === "undefined"),
      found: ${JSON.stringify(absent)}.filter((name) => { const [a, b] = name.split("."); return typeof globalThis[a] !== "undefined" && (!b || typeof globalThis[a][b] !== "undefined"); }),
      money: new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(1234.5),
      day: new Date(Date.UTC(2026, 0, 2, 3)).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
    }`);
    // console exists in V8 but writes nowhere: a script may call it; nothing offers it.
    expect(outcome.result).toEqual({ missing: [], found: ["console.log"], money: "$\u00a01.234,50", day: "2/1/2026" });
  });

  it("builds a query string with URLSearchParams, as a browser would", async () => {
    const outcome = await run(`
      const q = new URLSearchParams({ q: "Av. Corrientes 1234, Buenos Aires", format: "json" });
      q.append("limit", 5);
      q.set("format", "jsonv2");
      const parsed = new URLSearchParams("?a=1&b=x+y&b=%C3%B1&empty");
      return { text: q.toString(), has: q.has("limit"), get: parsed.get("b"), all: parsed.getAll("b"), empty: parsed.get("empty"), entries: [...parsed], size: parsed.size, json: JSON.stringify({ q }) }
    `);
    expect(outcome.result).toEqual({
      text: "q=Av.+Corrientes+1234%2C+Buenos+Aires&format=jsonv2&limit=5",
      has: true,
      get: "x y",
      all: ["x y", "ñ"],
      empty: "",
      entries: [["a", "1"], ["b", "x y"], ["b", "ñ"], ["empty", ""]],
      size: 4,
      json: '{"q":"q=Av.+Corrientes+1234%2C+Buenos+Aires&format=jsonv2&limit=5"}',
    });
  });

  it("can't reach the host through a copied-in value's prototype chain", async () => {
    // trigger is a copy, not a reference: its constructor is the isolate's own Object, whose Function can't see the host.
    const outcome = await run("return trigger.constructor.constructor('return typeof process')()", { a: 1 });
    expect(outcome.result).toBe("undefined");
  });

  it("stops a script that runs forever", async () => {
    await expect(run("while (true) {}")).rejects.toThrow(/timed out/i);
  }, 15_000);

  it("stops a script that tries to exhaust memory", async () => {
    await expect(run("const a = []; while (true) a.push(new Array(1e6).fill(1));")).rejects.toThrow();
  }, 20_000);

  it("only lets plain JSON data out", async () => {
    await expect(run("const o = {}; o.self = o; return o")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await run("return undefined")).result).toBeNull();
    expect((await run("return { when: new Date(0) }")).result).toEqual({ when: "1970-01-01T00:00:00.000Z" });
  });

  it("surfaces a thrown error as a failed step", async () => {
    await expect(run("throw new Error('nope')")).rejects.toThrow("nope");
  });
});
