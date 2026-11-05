type ChildWorkerTermination =
  | { readonly kind: "stopped" }
  | { readonly kind: "unconfirmed"; readonly stopped: Promise<void> };

export const WORKER_LOADER_QUOTA_MESSAGES = Object.freeze([
  "Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.",
  "Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations. Wait for one to finish before starting another.",
]);

/** A transport rejection says nothing about the guest's remaining execution. */
export class ChildWorkerDispatchError extends Error {
  readonly code: "CHILD_EXECUTION_FAILED" | "CLEANUP_UNCONFIRMED";
  readonly #termination: ChildWorkerTermination;

  constructor(cause: unknown, termination: ChildWorkerTermination) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ChildWorkerDispatchError";
    this.code = termination.kind === "stopped" ? "CHILD_EXECUTION_FAILED" : "CLEANUP_UNCONFIRMED";
    this.#termination =
      termination.kind === "stopped"
        ? termination
        : {
            kind: "unconfirmed",
            stopped: termination.stopped.catch(() => new Promise<void>(() => {})),
          };
  }

  get termination(): ChildWorkerTermination {
    return this.#termination;
  }
}

/** Only a locally confirmed pre-entry rejection may become a guest failed spawn. */
export function isStoppedWorkerLoaderQuotaFailure(error: unknown): boolean {
  if (
    !(error instanceof ChildWorkerDispatchError) ||
    error.code !== "CHILD_EXECUTION_FAILED" ||
    error.termination.kind !== "stopped"
  )
    return false;
  const cause = error.cause;
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "EAGAIN" &&
    WORKER_LOADER_QUOTA_MESSAGES.includes(cause.message)
  );
}
