import { describe, expect, it } from "vitest";
import { validateDefinitionLimits, WORKFLOW_DEFINITION_LIMITS as LIMITS } from "./definition-limits.js";

/** Workflow definition limits (Specification_Workflows.md §3.6), one case per limit. */
const op = (key: string, configuration: unknown = {}) => ({ id: `id-${key}`, type: "totalbase.finish-result", key, label: key, configuration_version: 1, configuration });
const start = { id: "start", type: "totalbase.start", key: "start", label: "Start", configuration_version: 1, configuration: { trigger: "MANUAL" } };
const definition = (operations: unknown[], connections: unknown[] = []) => ({ operations: [start, ...operations], connections });

function expectLimit(fn: () => void, ...fragments: string[]) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED", httpStatus: 422 });
    for (const fragment of fragments) expect((error as Error).message).toContain(fragment);
    return;
  }
  throw new Error("expected WORKFLOW_LIMIT_EXCEEDED");
}

/** A value nested `levels` deep counting the configuration itself as level 1. */
function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 1; i < levels; i++) value = { inner: value };
  return value;
}

describe("validateDefinitionLimits", () => {
  it("accepts a definition at every limit", () => {
    const operations = Array.from({ length: LIMITS.maxOperations - 1 }, (_, i) => op(`s${i}`));
    expect(() => validateDefinitionLimits(definition(operations))).not.toThrow();
    expect(() => validateDefinitionLimits(definition([op("deep", nested(LIMITS.maxConfigurationDepth))]))).not.toThrow();
    const fields = Object.fromEntries(Array.from({ length: LIMITS.maxMapFields }, (_, i) => [`f${i}`, i]));
    expect(() => validateDefinitionLimits(definition([op("wide", fields)]))).not.toThrow();
    expect(() => validateDefinitionLimits(definition([op("path", { result: `{{start.data.${"a".repeat(LIMITS.maxTemplatePathLength - 11)}}}` })]))).not.toThrow();
  });

  it("operations per workflow, Start included", () => {
    const operations = Array.from({ length: LIMITS.maxOperations }, (_, i) => op(`s${i}`));
    expectLimit(() => validateDefinitionLimits(definition(operations)), "101 operations", "operations per workflow");
  });

  it("connections per workflow", () => {
    const connections = Array.from({ length: LIMITS.maxConnections + 1 }, () => ({ source: "start", output: "next", target: "x" }));
    expectLimit(() => validateDefinitionLimits(definition([], connections)), "201 connections", "connections per workflow");
  });

  it("serialized configuration per operation, naming the operation", () => {
    expectLimit(() => validateDefinitionLimits(definition([op("big", { result: "x".repeat(LIMITS.maxConfigurationBytes) })])),
      'Step "big"', "serialized configuration per operation");
    // Bytes, not characters: 3-byte characters reach the limit sooner.
    expectLimit(() => validateDefinitionLimits(definition([op("wide_chars", { result: "€".repeat(LIMITS.maxConfigurationBytes / 3 + 1) })])), 'Step "wide_chars"');
  });

  it("workflow definition size", () => {
    const operations = Array.from({ length: 20 }, (_, i) => op(`s${i}`, { result: "x".repeat(60_000) }));
    expectLimit(() => validateDefinitionLimits(definition(operations)), "workflow definition size");
  });

  it("configuration nesting depth, without exhausting the stack on a pathological value", () => {
    expectLimit(() => validateDefinitionLimits(definition([op("deep", nested(LIMITS.maxConfigurationDepth + 1))])), 'Step "deep"', "configuration nesting depth");
    let array: unknown = [];
    for (let i = 0; i < 100_000; i++) array = [array];
    expectLimit(() => validateDefinitionLimits(definition([op("arrays", { value: array })])), "configuration nesting depth");
  });

  it("map fields per operation, in any nested object", () => {
    const fields = Object.fromEntries(Array.from({ length: LIMITS.maxMapFields + 1 }, (_, i) => [`f${i}`, i]));
    expectLimit(() => validateDefinitionLimits(definition([op("wide", { set: fields })])), 'Step "wide"', "101 fields", "map fields per operation");
  });

  it("template path length", () => {
    const path = `start.data.${"a".repeat(LIMITS.maxTemplatePathLength)}`;
    expectLimit(() => validateDefinitionLimits(definition([op("path", { body: { text: `Hi {{${path}}}` } })])), 'Step "path"', "template path length");
  });
});
