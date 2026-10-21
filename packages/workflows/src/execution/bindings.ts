/**
 * Run-scoped state threaded through `engine.ts`'s `walk()` - what a
 * `{{operation.data.field}}` template expression (templates.ts) resolves
 * against. The structured `Binding` type (literal/trigger-data/prior-
 * operation-reference) this file used to also define has been fully
 * retired - every field in the operation catalog that once used it
 * (including `totalbase.for-each`/`totalbase.process-batches`'s own
 * `items`/`source`, the last holdout) now uses `{{...}}` templates
 * instead, resolved centrally by `resolveTemplates()`.
 */
import type { RunSandbox } from "./code-handlers.js";

export interface RunState {
  /** The Start node's data - for MANUAL/TEST runs, whatever the test-run request supplied (no input form yet - see the Start handler's own comment). */
  triggerData: unknown;
  /** Every executed operation's own data result, keyed by node id - populated as the walk proceeds, so only already-executed predecessors are resolvable (never a forward/future reference). */
  results: Map<string, unknown>;
  /**
   * The same results as `results` above, keyed by each operation's own
   * user-facing `key` instead of its internal UUID - what `{{key.data...}}`
   * template expressions resolve against (templates.ts). Seeded with
   * `"start"` mapped to `{ data: triggerData }` before the walk begins, so
   * Start resolves through the exact same `{{start.data...}}` path as any
   * other operation - no separate "trigger data isn't wrapped" special
   * case a template author needs to remember (engine.ts's own doc comment
   * on why `state.triggerData` itself stays unwrapped - this map is what
   * papers over that for templates specifically).
   */
  resultsByKey: Map<string, unknown>;
  /**
   * The current `totalbase.for-each` item, valid only while the engine is
   * walking that operation's body (specs/Workflows.md §5.11's
   * `source: "iteration"` reference). Nested For each is
   * rejected at draft-save time (§3.4), so a single slot - not a
   * stack - is enough: a body can never itself contain another For each
   * whose own body would need to see a *different* current item.
   */
  currentItem?: unknown;
  /**
   * The `{ code, message, detail? }` of the step whose connected `error` output led
   * to the step now being resolved - `{{error.code}}`/`{{error.message}}`
   * (Workflows.md §4.1). Set only while resolving that one
   * direct target's configuration; undefined everywhere else.
   */
  currentError?: { code: string; message: string; detail?: unknown } | undefined;
  /**
   * The run's Execute JavaScript isolate (code-handlers.ts `RunSandbox`) -
   * created by the first such step, disposed by the engine when the run
   * ends; each step runs in a fresh context of it.
   */
  sandbox?: RunSandbox;
}
