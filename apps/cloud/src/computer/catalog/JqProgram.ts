import { ABI_VERSION, type KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import { KERNEL_JQ_ARTIFACT } from "../../kernel/KernelJqProgram.ts";
import type { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildCoreutilsProgram } from "../ChildCoreutilsProgram.ts";
import type { ChildWorkerCode } from "../ChildWorkerProgram.ts";
import type { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { ChildProgramFactory } from "./ChildProgramFactory.ts";

export interface ChildJqBindingOptions {
  readonly registry: KernelProgramRegistry;
  readonly loader: WorkerLoader | ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly lifetimes: ChildWorkerLifetimes;
  readonly child: ChildProgramFactory;
  readonly code: ChildWorkerCode;
}

/** Register jq's separate pin on the shared AgentOS filesystem host bridge. */
export function createChildJqBinding(options: ChildJqBindingOptions): KernelProgramBinding {
  const manifest = Object.freeze({
    name: "@agentos-software/jq",
    version: KERNEL_JQ_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint: `agentos-jq-${KERNEL_JQ_ARTIFACT.version}:${KERNEL_JQ_ARTIFACT.sha256}`,
  });
  const registered = options.registry.register(manifest);
  if (registered.status !== "ok") {
    const detail =
      registered.status === "error" ? registered.error.message : "registration blocked";
    throw new Error(`Could not register ${manifest.name}: ${detail}`);
  }

  return {
    manifest,
    implementation: options.child((admission) =>
      createChildCoreutilsProgram({
        ...admission,
        executable: "/usr/bin/jq",
        code: options.code,
        capacity: options.capacity,
        lifetimes: options.lifetimes,
        dispatch: createWorkerLoaderDispatch<KernelCoreutilsPort>(options.loader),
      }),
    ),
  };
}
