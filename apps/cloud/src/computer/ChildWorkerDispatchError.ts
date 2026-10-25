type ChildWorkerTermination =
  | { readonly kind: "stopped" }
  | { readonly kind: "unconfirmed"; readonly stopped: Promise<void> };

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
