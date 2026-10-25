import type { WasiDescriptor } from "./wasi/internal_wasi_descriptors.ts";

export function inheritsKernelCommandDescriptor(
  fd: number,
  descriptor: Pick<WasiDescriptor, "preopen">,
): boolean {
  return fd <= 2 || descriptor.preopen === true;
}
