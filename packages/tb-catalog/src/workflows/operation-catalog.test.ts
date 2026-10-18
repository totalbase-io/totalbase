import { describe, expect, it } from "vitest";
import { shapeErrors } from "@totalbase/shared";
import { OPERATION_CATALOG, OPERATION_GROUPS, isTerminalOperation, missingConfiguration, operationDefinition, operationMenu, operationOutputs } from "./operation-catalog.js";

const errors = (type: string, configuration: unknown) => shapeErrors("configuration", operationDefinition(type)!.configuration, configuration).map((issue) => issue.message);

describe("operation catalog", () => {
  it("names each type once, every one but Start in a menu group", () => {
    const types = OPERATION_CATALOG.map((definition) => definition.type);
    expect(new Set(types).size).toBe(types.length);
    const groups = new Set<string>(OPERATION_GROUPS.map((group) => group.key));
    for (const definition of OPERATION_CATALOG) {
      if (definition.type === "totalbase.start") expect(definition.group).toBeNull();
      else expect(groups.has(definition.group!)).toBe(true);
    }
    expect(operationMenu().flatMap((entry) => entry.operations).length).toBe(OPERATION_CATALOG.length - 1);
  });

  it("gives a loop its body port among its outputs, and only the Finish steps none", () => {
    for (const definition of OPERATION_CATALOG) {
      if (definition.bodyOutput) expect(definition.outputs).toContain(definition.bodyOutput);
    }
    expect(OPERATION_CATALOG.filter((definition) => isTerminalOperation(definition.type)).map((d) => d.type).sort()).toEqual(["totalbase.finish-error", "totalbase.finish-result"]);
  });

  it("derives a Select case's ports from its cases", () => {
    const configuration = { cases: [{ output: "high", filter: {} }, { output: "low", filter: {} }], hasDefault: true };
    expect(operationOutputs("totalbase.select-case", configuration)).toEqual(["high", "low", "default", "error"]);
    expect(operationOutputs("totalbase.select-case", {})).toEqual(["error"]);
    expect(operationOutputs("totalbase.condition", {})).toEqual(["true", "false", "error"]);
    expect(operationOutputs("acme.unknown", {})).toBeUndefined();
  });

  it("lists what a step lacks to be published", () => {
    expect(missingConfiguration("totalbase.create-records", {})).toEqual(["no table", "no records to create"]);
    expect(missingConfiguration("totalbase.create-records", { resource: "r", records: "{{start.data}}" })).toEqual([]);
    expect(missingConfiguration("totalbase.send-email", { to: "a@x.com", template: "t" })).toEqual([]);
    expect(missingConfiguration("totalbase.send-email", { to: "a@x.com" })).toEqual(["no subject or template"]);
    expect(missingConfiguration("totalbase.create-file", { name: "a.txt", content: "" })).toEqual([]);
    expect(missingConfiguration("totalbase.validate-data", { rules: [] })).toEqual(["no rules"]);
  });

  it("accepts what the editor writes, templates included", () => {
    expect(errors("totalbase.read-records", { resource: "r", query: { fields: "id,name", where: { name: { _eq: "{{start.data.name}}" } }, limit: 10 } })).toEqual([]);
    expect(errors("totalbase.create-records", { resource: "r", records: "{{start.data}}", emitEvents: true })).toEqual([]);
    expect(errors("totalbase.update-records", { resource: "r", where: {}, set: { status: "DONE" } })).toEqual([]);
    expect(errors("totalbase.send-email", { to: ["a@x.com", "b@x.com"], subject: "Hi", bodyType: "text", textBody: "...", attachments: "{{file.data.asset}}" })).toEqual([]);
    expect(errors("totalbase.process-batches", { source: "{{read.data}}", batchSize: 25 })).toEqual([]);
    expect(errors("totalbase.create-file", { name: "a.txt", folder: null })).toEqual([]);
  });

  it("refuses a field its type doesn't have and a value of the wrong kind, naming the path", () => {
    expect(errors("totalbase.read-records", { resorce: "r" })[0]).toContain('configuration has no "resorce"');
    expect(errors("totalbase.read-records", { query: { order: "name" } })[0]).toContain('configuration.query has no "order"');
    expect(errors("totalbase.create-records", { records: { name: "x" } })[0]).toContain("configuration.records");
    expect(errors("totalbase.http-request", { method: "FETCH" })[0]).toContain("configuration.method");
    expect(errors("totalbase.wait-resume", { waitSeconds: 0 })[0]).toContain("more than 0");
    // Wait takes its configuration literally: a template is not a number.
    expect(errors("totalbase.wait-resume", { waitSeconds: "{{start.data.n}}" })).not.toEqual([]);
  });

  it("checks a Select case's names", () => {
    expect(errors("totalbase.select-case", { cases: [{ output: "error", filter: {} }] })[0]).toContain('can\'t be "error"');
    expect(errors("totalbase.select-case", { cases: [{ output: "High", filter: {} }] })[0]).toContain("lowercase identifier");
    expect(errors("totalbase.select-case", { cases: [{ output: "a", filter: {} }, { output: "a", filter: {} }] })[0]).toContain("twice");
  });
});
