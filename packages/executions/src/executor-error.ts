/**
 * Thrown by an execution executor (Specification_Data_API.md §10.2)
 * to tell ExecutionsWorker whether the failure is worth
 * retrying. Any other thrown error is treated as non-retryable by
 * default - the safe default matches the spec's own non-retry list
 * (400/401/403/422-shaped errors), which callers don't need to wrap.
 */
export class RetryableExecutionExecutorError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryable = true as const;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The error code an executor throws to end its execution CANCELLED rather than FAILED (Specification_Data_API.md §10.5). */
export const EXECUTION_CANCELLED = "CANCELLED";

export class ExecutionExecutorError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryable = false as const;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
