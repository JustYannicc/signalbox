export interface KernelMemoryRegion {
  readonly pointer: number;
  readonly bytes: Uint8Array;
}

export interface KernelSyscallRequest {
  readonly name: string;
  readonly args: readonly (number | bigint)[];
  readonly memorySize: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export type KernelSyscallResponse =
  | {
      readonly kind: "return";
      readonly value: number;
      readonly regions: readonly KernelMemoryRegion[];
    }
  | { readonly kind: "exit"; readonly code: number };

export interface KernelSyscallPort {
  readonly call: (request: KernelSyscallRequest) => Promise<KernelSyscallResponse>;
}
