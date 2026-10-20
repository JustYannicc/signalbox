/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { createCallbackApi } from "./callbacks.ts";
import { createFsConstants, fsConstants, type NativeFsConstants } from "./constants.ts";
import { createWatchFile } from "./watchFile.ts";
import { createWatchEvents } from "./watchEvents.ts";
import { createPromisesApi } from "./promises.ts";
import { createSyncApi } from "./sync.ts";

export type NodeFsPromisesModule = ReturnType<typeof createPromisesApi> & {
  constants: typeof fsConstants;
  watch: ReturnType<typeof createWatchEvents>["watchPromises"];
  default: NodeFsPromisesModule;
};

export type NodeFsModule = ReturnType<typeof createSyncApi> &
  ReturnType<typeof createCallbackApi> &
  ReturnType<typeof createWatchFile> & {
    constants: typeof fsConstants;
    watch: ReturnType<typeof createWatchEvents>["watch"];
    promises: NodeFsPromisesModule;
    default: NodeFsModule;
  };

export interface NodeFsModules {
  readonly fs: NodeFsModule;
  readonly "fs/promises": NodeFsPromisesModule;
}

function defineDefault<T extends object>(module: T): T & { default: T } {
  Object.defineProperty(module, "default", {
    configurable: false,
    enumerable: true,
    value: module,
    writable: false,
  });
  return module as T & { default: T };
}

export function createNodeFs(
  kernelFs: KernelFileSystem,
  nativeConstants?: NativeFsConstants,
  runLeaf?: AsyncLeafRunner,
): NodeFsModules {
  const constants =
    nativeConstants === undefined ? fsConstants : createFsConstants(nativeConstants);
  const watchers = createWatchEvents(kernelFs, (close) => kernelFs.onDispose(close));
  const promiseModule = defineDefault(
    Object.assign(
      Object.create(null) as Record<string, unknown>,
      createPromisesApi(kernelFs, runLeaf),
      {
        constants,
        watch: watchers.watchPromises,
      },
    ),
  ) as unknown as NodeFsPromisesModule;

  const fsModule = defineDefault(
    Object.assign(
      Object.create(null) as Record<string, unknown>,
      createSyncApi(kernelFs, runLeaf),
      createCallbackApi(kernelFs, runLeaf),
      createWatchFile(kernelFs),
      {
        constants,
        watch: watchers.watch,
        promises: promiseModule,
      },
    ),
  ) as unknown as NodeFsModule;

  return Object.freeze({ fs: fsModule, "fs/promises": promiseModule });
}
