import { ABI_VERSION, KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import {
  KERNEL_BUSYBOX_VERSION,
  PRODUCT_COMPUTER_BUSYBOX_VERSION,
} from "../../kernel/KernelBusyboxPrograms.ts";
import { createChildBusyboxProgram } from "../ChildBusyboxProgram.ts";
import type { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import type { ChildWorkerCode } from "../ChildWorkerProgram.ts";
import type { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import { CHILD_BUSYBOX_APPLETS, CHILD_PRODUCT_BUSYBOX_APPLETS } from "../ChildProgramSet.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { ChildProgramFactory } from "./ChildProgramFactory.ts";

export interface ChildBusyboxBindingOptions {
  readonly registry: KernelProgramRegistry;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly lifetimes: ChildWorkerLifetimes;
  readonly child: ChildProgramFactory;
  readonly programs: {
    readonly busyboxCat: ChildWorkerCode;
    readonly busyboxApplets?: ChildWorkerCode;
    readonly productBusyboxApplets?: ChildWorkerCode;
  };
}

/** Bind the base applets and product-only applets to their separately pinned binaries. */
export function createChildBusyboxBindings(options: ChildBusyboxBindingOptions) {
  const dispatch = createWorkerLoaderDispatch<KernelBusyboxPort>(options.loader);
  const bindings = new Map<string, KernelProgramBinding>();
  const baseCode = options.programs.busyboxApplets ?? options.programs.busyboxCat;
  const baseApplets =
    options.programs.busyboxApplets === undefined ? (["cat"] as const) : CHILD_BUSYBOX_APPLETS;

  registerApplets(baseApplets, baseCode, KERNEL_BUSYBOX_VERSION);
  if (options.programs.productBusyboxApplets !== undefined) {
    registerApplets(
      CHILD_PRODUCT_BUSYBOX_APPLETS,
      options.programs.productBusyboxApplets,
      PRODUCT_COMPUTER_BUSYBOX_VERSION,
    );
  }
  return bindings;

  function registerApplets(applets: readonly string[], code: ChildWorkerCode, version: string) {
    for (const applet of applets) {
      const manifest = Object.freeze({
        name: `@nimbus/busybox/${applet}`,
        version,
        abiVersion: ABI_VERSION,
        requiredCapabilities: Object.freeze([]),
        entrypoint: `busybox-${version}:${applet}`,
      });
      register(options.registry, manifest);
      bindings.set(`/bin/${applet}`, {
        manifest,
        implementation: options.child((admission) =>
          createChildBusyboxProgram({
            ...admission,
            executable: `/bin/${applet}`,
            code,
            capacity: options.capacity,
            lifetimes: options.lifetimes,
            dispatch,
          }),
        ),
      });
    }
  }
}

function register(
  registry: KernelProgramRegistry,
  manifest: KernelProgramBinding["manifest"],
): void {
  const result = registry.register(manifest);
  if (result.status !== "ok") {
    const detail = result.status === "error" ? result.error.message : "registration blocked";
    throw new Error(`Could not register ${manifest.name}: ${detail}`);
  }
}
