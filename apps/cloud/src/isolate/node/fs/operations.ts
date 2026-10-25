import { nodeFsError } from "./errors.ts";

/** Receives exactly one raw kernel syscall, before Node error conversion. */
export type AsyncLeafRunner = <T>(operation: () => T, signal?: AbortSignal) => Promise<T>;
type FsLeaf = { readonly call: () => unknown; readonly cleanup: boolean };
export type FsOperation<T> = Generator<FsLeaf, T, unknown>;

export function* leaf<T>(operation: () => T, cleanup = false): FsOperation<T> {
  return (yield { call: operation, cleanup }) as T;
}

export function runSync<T>(operation: FsOperation<T>): T {
  let next = operation.next();
  while (!next.done) {
    let value;
    try {
      value = next.value.call();
    } catch (error) {
      next = operation.throw(error);
      continue;
    }
    next = operation.next(value);
  }
  return next.value;
}

export async function runAsync<T>(
  operation: FsOperation<T>,
  runLeaf?: AsyncLeafRunner,
  signal?: AbortSignal,
): Promise<T> {
  let next = operation.next();
  while (!next.done) {
    let value;
    try {
      const step = next.value;
      if (!step.cleanup) signal?.throwIfAborted();
      value = runLeaf && !step.cleanup ? await runLeaf(step.call, signal) : step.call();
    } catch (error) {
      next = operation.throw(error);
      continue;
    }
    next = operation.next(value);
  }
  return next.value;
}

export function* fsOperation<T>(
  syscall: string,
  path: string | undefined,
  operation: FsOperation<T>,
  dest?: string,
): FsOperation<T> {
  try {
    return yield* operation;
  } catch (cause) {
    throw nodeFsError(cause, syscall, path, dest);
  }
}
