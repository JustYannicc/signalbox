import type { FilePersistenceResult, ForkCommit } from "../FilePersistencePorts.ts";

export class KernelRevisionWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KernelRevisionWorkspaceError";
    this.code = code;
  }
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : undefined;
}

export function sameCommit(left: ForkCommit, right: ForkCommit): boolean {
  return (
    left.repository === right.repository && left.fork === right.fork && left.commit === right.commit
  );
}

export function persistenceError<T>(
  result: Extract<FilePersistenceResult<T>, { status: "error" }>,
): KernelRevisionWorkspaceError {
  return new KernelRevisionWorkspaceError(result.error.code, result.error.message);
}

export function assertUnchanged(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new KernelRevisionWorkspaceError(
      "LIVE_FILESYSTEM_DIVERGED",
      "The live filesystem changed after the command checkpoint; VM output was kept unapplied",
    );
  }
}
