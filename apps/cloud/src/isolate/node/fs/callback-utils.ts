/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import { nodeFsError } from "./errors.ts";

export type FsCallback<T extends unknown[] = []> = (
  error: NodeJS.ErrnoException | null,
  ...values: T
) => void;

export function schedule<T extends unknown[]>(
  callback: FsCallback<T>,
  operation: () => T | Promise<T>,
  syscall: string,
  path?: string,
  dest?: string,
): void {
  if (typeof callback !== "function") {
    throw new TypeError("The callback argument must be a function");
  }
  void Promise.resolve()
    .then(operation)
    .then(
      (result) => queueMicrotask(() => callback(null, ...result)),
      (error: unknown) =>
        queueMicrotask(() =>
          callback(
            nodeFsError(error, syscall, path, dest) as NodeJS.ErrnoException,
            ...([] as unknown as T),
          ),
        ),
    );
}
