/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { createCallbackApi } from "./callbacks.ts";
import { createFsConstants, fsConstants, type NativeFsConstants } from "./constants.ts";
import { unsupportedFs } from "./errors.ts";
import { createPromisesApi } from "./promises.ts";
import { createSyncApi } from "./sync.ts";
import { pathString, type PathLike } from "./path.ts";

export type NodeFsPromisesModule = ReturnType<typeof createPromisesApi> & {
  constants: typeof fsConstants;
  default: NodeFsPromisesModule;
};

export type NodeFsModule = ReturnType<typeof createSyncApi> &
  ReturnType<typeof createCallbackApi> & {
    constants: typeof fsConstants;
    promises: NodeFsPromisesModule;
    default: NodeFsModule;
    watch: (path: PathLike, ...args: unknown[]) => never;
    watchFile: (path: PathLike, ...args: unknown[]) => never;
    unwatchFile: (path?: PathLike, ...args: unknown[]) => never;
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
): NodeFsModules {
  const constants =
    nativeConstants === undefined ? fsConstants : createFsConstants(nativeConstants);
  const promiseModule = defineDefault(
    Object.assign(Object.create(null) as Record<string, unknown>, createPromisesApi(kernelFs), {
      constants,
    }),
  ) as unknown as NodeFsPromisesModule;

  const fsModule = defineDefault(
    Object.assign(
      Object.create(null) as Record<string, unknown>,
      createSyncApi(kernelFs),
      createCallbackApi(kernelFs),
      {
        constants,
        promises: promiseModule,
        watch: (path: PathLike) => {
          throw unsupportedFs("watch", pathString(path));
        },
        watchFile: (path: PathLike) => {
          throw unsupportedFs("watchFile", pathString(path));
        },
        unwatchFile: (path?: PathLike) => {
          throw unsupportedFs("unwatchFile", path === undefined ? undefined : pathString(path));
        },
      },
    ),
  ) as unknown as NodeFsModule;

  return Object.freeze({ fs: fsModule, "fs/promises": promiseModule });
}
