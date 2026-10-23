import { createKernelBashReactor } from "../kernel/KernelBashReactor.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelBashCall, KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import { createChildWasi } from "./ChildWasi.ts";
import { createChildBashImports } from "./ChildBashImports.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";
import type { BashAsyncifyOperationHooks } from "../kernel/KernelBashCheckpoint.ts";
import type {
  KernelBashOperation,
  KernelBashOperationResult,
} from "../kernel/KernelBashCheckpoint.ts";

export interface ChildBashOptions {
  readonly module: WebAssembly.Module;
  readonly residentWasmBudgetBytes?: number;
  readonly localForkPackingBytes?: number;
  readonly credentials: KernelBashCredentials;
  readonly pid: number;
  readonly port: KernelBashPort;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly snapshot?: KernelBashForkSource | undefined;
  readonly createForkSource?: (
    source: KernelBashForkSource,
  ) => KernelBashForkSource | Promise<KernelBashForkSource>;
}

/** Run the unchanged GNU Bash image in the child, including its Nimbus Asyncify ABI. */
export function createChildBash(options: ChildBashOptions) {
  return createKernelBashReactor({
    ...options,
    residentWasmBudgetBytes: options.residentWasmBudgetBytes ?? 104 * 1024 * 1024,
    localForkPackingBytes: options.localForkPackingBytes ?? 64 * 1024 * 1024,
    createForkSource: async (source) => {
      const transformed = (await options.createForkSource?.(source)) ?? source;
      const { RpcTarget } = await import("cloudflare:workers");
      class ForkSourceCapability extends RpcTarget implements KernelBashForkSource {
        #source: KernelBashForkSource | undefined = transformed;

        state() {
          return this.#require().state();
        }

        read(offset: number, length: number) {
          return this.#require().read(offset, length);
        }

        async restored() {
          const source = this.#require();
          this.#source = undefined;
          await source.restored();
        }

        #require() {
          if (this.#source === undefined)
            throw new Error("Bash fork source capability has been released");
          return this.#source;
        }
      }
      return new ForkSourceCapability();
    },
    createBinding(port, asyncify: BashAsyncifyOperationHooks, residentWasmBytes) {
      const observed = {
        call: (request: KernelSyscallRequest) =>
          port.call({ ...request, residentWasmBytes: residentWasmBytes() }),
        callBash: (request: KernelBashCall) =>
          port.callBash({ ...request, residentWasmBytes: residentWasmBytes() }),
      };
      const wasi = createChildWasi({ ...options, syscalls: observed, asyncify });
      const bash = createChildBashImports({ module: options.module, port: observed, asyncify });
      return {
        imports: { ...wasi.imports, ...bash.imports },
        applyOperation(operation: KernelBashOperation, call, result: KernelBashOperationResult) {
          if (operation.kind === "wasi") return wasi.applyOperation(call, result);
          if (operation.kind === "bash") return bash.applyOperation(call, result);
          throw new TypeError(`No guest memory adapter for ${operation.kind} operation`);
        },
        bind(instance) {
          wasi.bind(instance);
          bash.bind(instance);
        },
        run: (start) => wasi.run(start),
      };
    },
  });
}
