/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import { callFs } from "./errors.ts";

export type FsCallback<T extends unknown[] = []> = (
  error: NodeJS.ErrnoException | null,
  ...values: T
) => void;

export function schedule<T extends unknown[]>(
  callback: FsCallback<T>,
  operation: () => T,
  syscall: string,
  path?: string,
  dest?: string,
): void {
  if (typeof callback !== "function") {
    throw new TypeError("The callback argument must be a function");
  }
  queueMicrotask(() => {
    let result: T;
    try {
      result = callFs(syscall, path, operation, dest);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, ...([] as unknown as T));
      return;
    }
    callback(null, ...result);
  });
}
