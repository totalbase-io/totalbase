import { TotalBaseError } from "@totalbase/errors";
import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "./graph-validation.js";

type Op = { id: string; type: string; key?: string; label?: string; parent?: string; configuration?: Record<string, unknown> };
type Conn = { source: string; target: string; output: string };

const op = (id: string, type: string, extra: Partial<Op> = {}): Op => ({ id, type, key: id, configuration: {}, ...extra });
const START = op("start", "totalbase.start", { configuration: { trigger: "MANUAL" } });

function expectInvalid(operations: Op[], connections: Conn[], message: RegExp): void {
  let thrown: unknown;
  try {
    validateWorkflowGraph({ operations, connections });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TotalBaseError);
  expect((thrown as TotalBaseError).code).toBe("WORKFLOW_INVALID_DESIGN");
  expect((thrown as TotalBaseError).message).toMatch(message);
}

/** The graph rules of Specification_Workflows.md §3.3/§3.4, checked on save and publish. */
describe("validateWorkflowGraph", () => {
  it("accepts a tree: branches, an error branch, a loop body and an unconnected output", () => {
    expect(() => validateWorkflowGraph({
      operations: [
        START,
        op("read", "totalbase.read-records"),
        op("check", "totalbase.condition"),
        op("each", "totalbase.for-each"),
        op("body", "totalbase.create-records", { parent: "each" }),
        op("after", "totalbase.finish-result"),
        op("pick", "totalbase.select-case", { configuration: { cases: [{ output: "big" }], hasDefault: true } }),
        op("big", "totalbase.finish-result", { key: "big_done" }),
        op("other", "totalbase.finish-result"),
        op("failed", "totalbase.finish-error"),
      ],
      connections: [
        { source: "start", target: "read", output: "next" },
        { source: "read", target: "failed", output: "error" },
        { source: "read", target: "check", output: "next" },
        { source: "check", target: "each", output: "true" },
        { source: "check", target: "pick", output: "false" },
        { source: "each", target: "body", output: "item" },
        { source: "each", target: "after", output: "done" },
        { source: "pick", target: "big", output: "big" },
        { source: "pick", target: "other", output: "default" },
      ],
    })).not.toThrow();
  });

  it("names the operation for each broken rule", () => {
    const read = op("read", "totalbase.read-records");
    const finish = op("finish", "totalbase.finish-result");
    expectInvalid([START, read], [{ source: "start", target: "gone", output: "next" }], /"start".*gone, which does not exist/);
    expectInvalid([START, read], [{ source: "gone", target: "read", output: "next" }], /gone, which does not exist/);
    expectInvalid([START, read], [{ source: "start", target: "read", output: "error" }], /Operation "start" has no "error" output/);
    expectInvalid([START, read, finish], [
      { source: "start", target: "read", output: "next" },
      { source: "read", target: "finish", output: "true" },
    ], /Operation "read" has no "true" output/);
    expectInvalid([START, finish, read], [
      { source: "start", target: "finish", output: "next" },
      { source: "finish", target: "read", output: "next" },
    ], /Operation "finish" has no "next" output/);
    expectInvalid([START, read, finish], [
      { source: "start", target: "read", output: "next" },
      { source: "start", target: "finish", output: "next" },
    ], /"start"'s "next" output is connected more than once/);
    expectInvalid([START, read, op("cond", "totalbase.condition")], [
      { source: "start", target: "cond", output: "next" },
      { source: "cond", target: "read", output: "true" },
      { source: "cond", target: "read", output: "false" },
    ], /Operation "read" has more than one incoming connection/);
    expectInvalid([START, read], [
      { source: "start", target: "read", output: "next" },
      { source: "read", target: "start", output: "next" },
    ], /Start operation cannot have an incoming connection/);
    expectInvalid([START, read], [{ source: "read", target: "read", output: "next" }], /"read" is connected to itself/);
  });

  it("rejects a cycle among operations not reached from Start", () => {
    expectInvalid([START, op("a", "totalbase.read-records"), op("b", "totalbase.read-records")], [
      { source: "a", target: "b", output: "next" },
      { source: "b", target: "a", output: "next" },
    ], /part of a cycle/);
  });

  it("checks Select case outputs against its configured cases", () => {
    const pick = op("pick", "totalbase.select-case", { configuration: { cases: [{ output: "big" }] } });
    expectInvalid([START, pick, op("d", "totalbase.finish-result")], [
      { source: "start", target: "pick", output: "next" },
      { source: "pick", target: "d", output: "default" },
    ], /"pick" has no "default" output/);
  });

  it("rejects a loop inside another loop's body - by `parent` and by the graph", () => {
    const outer = op("outer", "totalbase.for-each");
    expectInvalid([START, outer, op("inner", "totalbase.process-batches", { parent: "outer" })], [], /"inner" cannot be placed inside another loop/);
    expectInvalid([START, outer, op("step", "totalbase.read-records"), op("inner", "totalbase.for-each")], [
      { source: "start", target: "outer", output: "next" },
      { source: "outer", target: "step", output: "item" },
      { source: "step", target: "inner", output: "next" },
    ], /"inner" cannot be placed inside the body of loop operation "outer"/);
  });

  it("requires exactly one Start keyed start, and unique, unreserved step keys", () => {
    expectInvalid([op("read", "totalbase.read-records")], [], /exactly one Start/);
    expectInvalid([START, { ...START, id: "start2" }], [], /share the step key "start"|exactly one Start/);
    expectInvalid([{ ...START, key: "begin" }], [], /Start operation's key must be "start"/);
    expectInvalid([START, op("a", "totalbase.read-records", { key: "dup" }), op("b", "totalbase.read-records", { key: "dup" })], [], /share the step key "dup"/);
    for (const reserved of ["item", "error", "start"]) {
      expectInvalid([START, op("a", "totalbase.read-records", { key: reserved })], [], new RegExp(`"${reserved}" is a reserved step key`));
    }
    expectInvalid([START, START], [], /used twice/);
  });

  it("checks each step's configuration against its catalog shape, every problem at once", () => {
    expectInvalid([
      START,
      op("read", "totalbase.read-records", { configuration: { resorce: "r" } }),
      op("wait", "totalbase.wait-resume", { configuration: { waitSeconds: "soon" } }),
    ], [
      { source: "start", target: "read", output: "next" },
      { source: "read", target: "wait", output: "next" },
    ], /Operation "read": configuration has no "resorce"[\s\S]*Operation "wait": configuration.waitSeconds/);
  });

  it("leaves a type TotalBase doesn't have to the publish check", () => {
    expect(() => validateWorkflowGraph({ operations: [START, op("x", "acme.custom", { configuration: { anything: 1 } })], connections: [{ source: "start", target: "x", output: "next" }] })).not.toThrow();
  });
});
