import { TotalBaseError } from "@totalbase/errors";
import type { OperationHandler } from "./types.js";

/**
 * `totalbase.wait-resume` - only the timed-wait half (catalog table's own
 * "Suspend until a date or signal"). The signal-based resume half is
 * deliberately out of scope, permanently, not just deferred: a workflow
 * run here is a synchronous, in-process execution (engine.ts's `walk()`),
 * never persisted mid-flight - waking one from an external call would
 * need a whole suspend/serialize/resume model this engine doesn't have
 * and was never asked to build. A fixed-duration wait needs none of
 * that: the run's own execution promise just stays parked on a timer,
 * exactly like it's already parked on any other slow `await` (a query,
 * an outbound HTTP call) - the existing crash-recovery lease
 * (`WorkflowRunsService.reclaimExpired()`) already covers "the process
 * died while a run was mid-flight" the same way for a wait as for
 * anything else.
 *
 * Bounded by `workflows.max_run_duration_ms` (the run's own total
 * lifetime budget) - a single wait can't legally ask for longer than the
 * whole run is allowed to live. Practical use is therefore seconds to a
 * few minutes (retry backoff, rate-limit spacing), not hours/days - a
 * long-duration wait would need real persistence and is out of scope.
 */
const waitResume: OperationHandler = async ({ configuration, context }) => {
  const waitSeconds = Number(configuration.waitSeconds);
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
    throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no valid wait time configured.");
  }
  const waitMs = waitSeconds * 1000;
  const maxRunMs = await context.settings.get("workflows.max_run_duration_ms");
  if (waitMs > maxRunMs) {
    throw new TotalBaseError("WORKFLOW_LIMIT_EXCEEDED", `This step's wait time (${waitSeconds}s) exceeds the maximum run duration (workflows.max_run_duration_ms).`);
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return { output: "next", result: { waitedSeconds: waitSeconds } };
};

export const WAIT_RESUME_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.wait-resume": waitResume,
};
