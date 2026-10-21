import { describe, expect, it } from "vitest";
import { OPERATION_CATALOG } from "@totalbase/tb-catalog";
import { OPERATION_HANDLERS } from "./handlers.js";

/** The catalog (Workflows.md §5.25) and the runtime agree: every `runs: "handler"` entry has its handler, and no handler runs a type the catalog doesn't have. */
describe("operation catalog and handlers", () => {
  it("has one handler per handler-run operation", () => {
    const handled = OPERATION_CATALOG.filter((definition) => definition.runs === "handler").map((definition) => definition.type).sort();
    expect(Object.keys(OPERATION_HANDLERS).sort()).toEqual(handled);
  });
});
