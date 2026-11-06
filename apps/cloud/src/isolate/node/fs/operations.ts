import { nodeFsError } from "./errors.ts";
import type {
  NodeFsBackend,
  NodeFsOperation,
  NodeFsArguments,
  NodeFsResult,
} from "../../NodeFsBackend.ts";

/** Receives exactly one raw kernel syscall, before Node error conversion. */
export type AsyncLeafRunner = <T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
type FsLeaf = {
  readonly call: (signal?: AbortSignal) => unknown;
  readonly asynchronous?: (signal?: AbortSignal) => Promise<unknown>;
  readonly cleanup: boolean;
};
export type FsOperation<T> = Generator<FsLeaf, T, unknown>;

export function* leaf<T>(operation: () => T, cleanup = false): FsOperation<T> {
  return (yield { call: operation, cleanup }) as T;
}

export function* fileLeaf<K extends NodeFsOperation>(
  filesystem: NodeFsBackend,
  name: K,
  args: NodeFsArguments<K>,
  cleanup = false,
): FsOperation<NodeFsResult<K>> {
  return (yield {
    call: () => Reflect.apply(filesystem[name], filesystem, args),
    ...(filesystem.asynchronous === undefined
      ? {}
      : { asynchronous: (signal?: AbortSignal) => filesystem.asynchronous!(name, args, signal) }),
    cleanup,
  }) as NodeFsResult<K>;
}

export function* asyncLeaf<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  cleanup = false,
): FsOperation<T> {
  return (yield { call: operation, cleanup }) as T;
}

export function runSync<T>(operation: FsOperation<T>): T {
  let next = operation.next();
  while (!next.done) {
    let value;
    try {
      value = next.value.call();
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof Reflect.get(value, "then") === "function"
      )
        throw new TypeError("A synchronous filesystem operation returned a Promise");
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
      const call = () => (step.asynchronous ?? step.call)(step.cleanup ? undefined : signal);
      value = runLeaf && !step.cleanup ? await runLeaf(call, signal) : await call();
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
