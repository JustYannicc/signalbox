/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ./bun/LICENSE.agentos and ./bun/NOTICE.agentos.
 */
export { KernelOpenFlags } from "../kernel/KernelFileSystem.ts";
export type { NodeFsModules } from "./node/fs/factory.ts";
export { createNodeFs } from "./node/fs/factory.ts";
