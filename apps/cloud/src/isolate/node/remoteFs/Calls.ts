// @effect-diagnostics cryptoRandomUUID:off - Correlation ids belong to the portable syscall client.
import type { KernelFsSyscallArguments } from "../../../kernel/KernelFsSyscallAbi.ts";
import type { KernelSyscallPort } from "../../../kernel/KernelSyscallPort.ts";
import { SyscallFrame } from "./Frame.ts";

export interface NodeFsSyscallTransport extends KernelSyscallPort {
  cancel?(id: string, reason?: unknown): Promise<void>;
}

export class NodeFsSyscalls {
  readonly port;
  readonly root;
  constructor(port: NodeFsSyscallTransport, root: number) {
    this.port = port;
    this.root = root;
  }

  async call<K extends keyof KernelFsSyscallArguments>(
    frame: SyscallFrame,
    name: K,
    args: KernelFsSyscallArguments[K],
    signal?: AbortSignal,
    creationMode?: number,
    kernelOpenFlags?: number,
  ) {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= this.port.cancel?.(id, signal?.reason);
      void cancellation?.catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const response = await this.port.call({
        name,
        args,
        memorySize: frame.memorySize,
        regions: frame.regions,
        operationId: id,
        ...(creationMode === undefined ? {} : { creationMode }),
        ...(kernelOpenFlags === undefined ? {} : { kernelOpenFlags }),
      });
      frame.accept(response);
      if (name === "path_open" && signal?.aborted) {
        const fd = frame.u32(Number(args[8]));
        await this.call(new SyscallFrame(), "fd_close", [fd]);
      }
      signal?.throwIfAborted();
      return frame;
    } finally {
      signal?.removeEventListener("abort", cancel);
      await cancellation;
    }
  }
}
