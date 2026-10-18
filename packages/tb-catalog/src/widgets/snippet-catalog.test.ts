import { describe, expect, it } from "vitest";
import { renderSnippet, SNIPPET_CATALOG, SNIPPET_NAMES, snippetDefaults, validateSnippet, type SnippetParams } from "./snippet-catalog.js";

/** A sample answer for each param editor. */
function sample(editor: string): unknown {
  switch (editor) {
    case "variable":
      return "clientes";
    case "control":
      return "confirmar";
    case "dataview":
      return "emitir-factura";
    case "boolean":
      return true;
    case "snippet":
      return { snippet: "notify", params: { message: "Listo" } };
    default:
      return "Hola";
  }
}
function sampleParams(name: (typeof SNIPPET_NAMES)[number]): SnippetParams {
  const params: SnippetParams = { ...snippetDefaults(name) };
  for (const [key, param] of Object.entries(SNIPPET_CATALOG[name].params)) {
    if (param.editor !== "select") params[key] = sample(param.editor);
  }
  return params;
}
/** Compiles as a handler body - an async function of (dataview, event). */
function compiles(lines: string[]): void {
   
  new Function("dataview", "event", `return (async () => {\n${lines.join("\n")}\n})()`);
}

describe("SNIPPET_CATALOG", () => {
  it("renders every snippet, with every option, as code that compiles", () => {
    for (const name of SNIPPET_NAMES) {
      const params = sampleParams(name);
      expect(validateSnippet(name, params), name).toEqual([]);
      compiles(renderSnippet(name, params));
      for (const [key, param] of Object.entries(SNIPPET_CATALOG[name].params)) {
        if (param.editor !== "select") continue;
        for (const option of param.options) compiles(renderSnippet(name, { ...params, [key]: option.value }));
      }
    }
  });

  it("escapes what the author types - a message never breaks the code", () => {
    const lines = renderSnippet("notify", { message: 'Dijo "hola"\n`${alert(1)}`', color: "info" });
    expect(lines).toEqual(['dataview.notify("Dijo \\"hola\\"\\n`${alert(1)}`", "info")']);
    compiles(lines);
  });

  it("nests a snippet after a confirmation", () => {
    expect(renderSnippet("confirmThen", { message: "¿Emitir?", then: { snippet: "saveRecord", params: { then: "new" } } })).toEqual([
      'if (!await dataview.confirm("¿Emitir?")) return',
      "if (!await dataview.vars.record.save()) return",
      "dataview.vars.record.new()",
    ]);
  });

  it("titles a confirmation when asked - a summary with its own button", () => {
    expect(renderSnippet("confirmThen", { message: "Total: $ 100", title: "Cobro: Contado", button: "Emitir" })[0]).toBe(
      'if (!await dataview.confirm({ title: "Cobro: Contado", lines: ["Total: $ 100"], confirm: "Emitir" })) return',
    );
  });

  it("refuses what's missing and names that aren't identifiers", () => {
    expect(validateSnippet("refreshData", {})).toEqual(["Resource is required."]);
    expect(validateSnippet("refreshData", { resource: "x.refresh(); evil()" })).toEqual(["Resource must be a name."]);
    expect(validateSnippet("openDataView", { dataview: "../admin" })).toEqual(["DataView must be a DataView's slug."]);
    expect(validateSnippet("confirmThen", { message: "?", then: { snippet: "refreshData", params: {} } })).toEqual(["Then: Resource is required."]);
    expect(validateSnippet("nope", {})).toEqual(['Unknown snippet "nope".']);
  });
});
