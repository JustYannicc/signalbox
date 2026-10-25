import { ABI_VERSION, KernelProgramRegistry } from "./KernelAbi.ts";
import { createKernelBusyboxProgram } from "./KernelBusyboxProgram.ts";
import type { KernelProgramBinding } from "./KernelProgramHost.ts";

export const KERNEL_BUSYBOX_VERSION = "1.37.0+nimbus.e9f019ab";

/** Register only the pinned BusyBox applet that has a kernel handoff proof. */
export function registerKernelBusyboxCat(
  registry: KernelProgramRegistry,
  module: WebAssembly.Module,
): ReadonlyMap<string, KernelProgramBinding> {
  const manifest = Object.freeze({
    name: "@nimbus/busybox/cat",
    version: KERNEL_BUSYBOX_VERSION,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint: `busybox-${KERNEL_BUSYBOX_VERSION}:cat`,
  });
  const registered = registry.register(manifest);
  if (registered.status === "error") {
    throw Object.assign(new Error(`Could not register BusyBox cat: ${registered.error.message}`), {
      code: registered.error.code,
    });
  }
  if (registered.status === "would_block") {
    throw new Error("BusyBox registry unexpectedly blocked cat");
  }
  return new Map([
    [
      "/bin/cat",
      {
        manifest,
        implementation: createKernelBusyboxProgram({ module }),
      },
    ],
  ]);
}
