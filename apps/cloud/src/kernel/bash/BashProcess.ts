import type { KernelBashCredentials, KernelBashProgramContext } from "./BashContext.ts";
import type { BashCaptureStore, CaptureStats } from "./BashCaptureStore.ts";
import type { WasiLifecycle } from "../wasi/internal_wasi_lifecycle.ts";
import type { BashPreopens } from "./BashPreopens.ts";

export interface BashExports {
  readonly memory: WebAssembly.Memory;
  readonly __stack_pointer: WebAssembly.Global;
  readonly __data_end: WebAssembly.Global;
  readonly __heap_base: WebAssembly.Global;
  readonly _start: () => void;
  readonly nimbus_procenv_log: () => number;
  readonly asyncify_start_unwind: (pointer: number) => void;
  readonly asyncify_stop_unwind: () => void;
  readonly asyncify_start_rewind: (pointer: number) => void;
  readonly asyncify_stop_rewind: () => void;
}

export type BashTransition =
  | { readonly kind: "capture"; readonly env: number; readonly stack: number }
  | { readonly kind: "longjmp"; readonly env: number; readonly value: number }
  | { readonly kind: "fork" }
  | {
      readonly kind: "wait";
      readonly pid: number;
      readonly status: number;
      readonly options: number;
    }
  | {
      readonly kind: "exec";
      readonly path: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };

export interface BashProcess {
  readonly context: KernelBashProgramContext;
  readonly credentials: KernelBashCredentials;
  readonly lifecycle: WasiLifecycle;
  readonly stats: CaptureStats;
  readonly preopens: BashPreopens;
  instance: WebAssembly.Instance;
  exports: BashExports;
  captures: BashCaptureStore;
  rewinding: boolean;
  resume: number;
  pending: BashTransition | undefined;
}
