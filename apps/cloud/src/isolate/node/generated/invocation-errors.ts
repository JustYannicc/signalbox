export class NodeGeneratedCodeCleanupError extends Error {
  readonly code = "CLEANUP_UNCONFIRMED";

  constructor(cause: unknown) {
    super("Generated-code cleanup was not acknowledged; the child may still be running", { cause });
    this.name = "NodeGeneratedCodeCleanupError";
  }
}
