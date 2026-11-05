import { ABI_VERSION } from "../../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import type { ChildWorkerCode } from "../ChildWorkerCode.ts";

export type ComputerProgramHostKind = "bash" | "syscall" | "busybox" | "coreutils" | "git";
export interface ComputerCatalogProgram {
  readonly executable: string;
  readonly implementation: string;
  readonly manifest: KernelProgramBinding["manifest"];
  readonly code: ChildWorkerCode;
  readonly hostKind: ComputerProgramHostKind;
  readonly sigpipe?: "epipe";
  readonly pwd?: true;
}
export type ChildProgramFactory = (
  executable: string,
  code: ChildWorkerCode,
  hostKind: ComputerProgramHostKind,
  manifest: ComputerCatalogProgram["manifest"],
  extras?: Pick<ComputerCatalogProgram, "sigpipe" | "pwd">,
) => void;

export function childProgramManifest(name: string, version: string, entrypoint: string) {
  return Object.freeze({
    name,
    version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint,
  });
}
