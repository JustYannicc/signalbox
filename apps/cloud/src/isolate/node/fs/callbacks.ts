/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { createIoCallbackApi } from "./callback-io.ts";
import { createPathCallbackApi } from "./callback-path.ts";

export { type FsCallback } from "./callback-utils.ts";

import type { AsyncLeafRunner } from "./operations.ts";

export function createCallbackApi(kernelFs: KernelFileSystem, runLeaf?: AsyncLeafRunner) {
  return { ...createIoCallbackApi(kernelFs, runLeaf), ...createPathCallbackApi(kernelFs, runLeaf) };
}
