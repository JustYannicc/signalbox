// @effect-diagnostics cryptoRandomUUID:off - Async command identities cross the host/kernel capability boundary.
import { claudeKernelOperation } from "./ClaudeKernelOperation.ts";
import type { Computer } from "../computer/Computer.ts";
import type { ClaudeKernelSessionPort } from "./ClaudeKernelSessionPort.ts";
import { rpcStubOwner, releaseRpcResult } from "../rpc/Resources.ts";
import { ownRpcResponse } from "../rpc/response.ts";

/** A host has no local files or process table. Nested process requesters stay in the kernel. */
export function claudeKernelComputer(
  kernel: ClaudeKernelSessionPort,
  threadId: string,
  files: unknown,
  lifetime: AbortSignal,
  localOnly = false,
): Computer<unknown> {
  return {
    threadId,
    files,
    async exec(command, externalSignal, requester) {
      if (requester !== undefined)
        throw new TypeError("Kernel process requesters cannot originate in the orchestration host");
      const signal = AbortSignal.any([lifetime, externalSignal]);
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const abort = () => {
        void kernel.cancel(id, signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const remote = await kernel.exec(id, command, localOnly);
        const control = remote.control;
        const exited = control.exited();
        void exited.catch(() => undefined);
        let disposed: Promise<void> | undefined;
        return {
          stdin: remote.stdin,
          stdout: remote.stdout,
          stderr: remote.stderr,
          exited,
          signal: (number) => control.signal(number),
          dispose: () =>
            (disposed ??= (async () => {
              try {
                using _owner = rpcStubOwner(control);
                await control.dispose();
              } finally {
                signal.removeEventListener("abort", abort);
                releaseRpcResult(remote);
              }
            })()),
        };
      } catch (error) {
        signal.removeEventListener("abort", abort);
        throw error;
      }
    },
    async port(port, externalSignal) {
      const signal = AbortSignal.any([lifetime, externalSignal]);
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const abort = () => {
        void kernel.cancel(id, signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const remote = await kernel.port(port, id);
        return {
          async fetch(request: Request) {
            const fetching = AbortSignal.any([signal, request.signal]);
            fetching.throwIfAborted();
            const requestId = crypto.randomUUID();
            const cancel = () => {
              void remote.cancel(requestId, fetching.reason).catch(() => undefined);
            };
            fetching.addEventListener("abort", cancel, { once: true });
            if (fetching.aborted) cancel();
            try {
              return await ownRpcResponse(await remote.fetch(requestId, request), {
                signal: fetching,
                release: () => fetching.removeEventListener("abort", cancel),
                bodyOpened() {},
                bodyClosed() {},
                bodyBytes() {},
                socketOpened() {},
                socketClosed() {},
              });
            } catch (error) {
              fetching.removeEventListener("abort", cancel);
              throw error;
            }
          },
        };
      } catch (error) {
        signal.removeEventListener("abort", abort);
        throw error;
      }
    },
    async save(signal) {
      AbortSignal.any([lifetime, signal]).throwIfAborted();
      return await claudeKernelOperation(kernel, AbortSignal.any([lifetime, signal]), (id) =>
        kernel.save(id),
      );
    },
  };
}
