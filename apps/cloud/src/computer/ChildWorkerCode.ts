import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import type { ChildWorkerLimits } from "./ChildWorkerLimits.ts";

export type ChildWorkerModule =
  | string
  | { readonly js: string }
  | { readonly wasm: ArrayBuffer | WebAssembly.Module }
  | { readonly wasmReference: string };

export type ChildWorkerModules = Readonly<Record<string, ChildWorkerModule>>;
export type ChildWorkerModulesFactory = () => ChildWorkerModules | Promise<ChildWorkerModules>;

export interface ChildWorkerCode {
  readonly mainModule: string;
  readonly modules: ChildWorkerModules | ChildWorkerModulesFactory;
  readonly entrypoint?: string;
  readonly limits?: ChildWorkerLimits;
}

export interface ChildWorkerInvocation extends Omit<ChildWorkerCode, "modules"> {
  readonly loaderId: string;
  readonly modules: ChildWorkerModules;
  readonly command: KernelCommand;
}
