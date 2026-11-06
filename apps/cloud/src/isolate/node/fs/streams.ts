/* Adapted from Rivet agentOS's Node fs bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * Licensed under Apache-2.0; see ../../bun/LICENSE.agentos and ../../bun/NOTICE.agentos.
 */
import type { DescriptorLifetime } from "./descriptor-lifetime.ts";
import type { NodeFsBackend } from "../../NodeFsBackend.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import type { PathLike } from "./path.ts";
import { NodeFsReadStream, type ReadStreamOptions } from "./read-stream.ts";
import { NodeFsWriteStream, type WriteStreamOptions } from "./write-stream.ts";

export { NodeFsReadStream, type ReadStreamOptions, NodeFsWriteStream, type WriteStreamOptions };

export function createReadStream(
  kernelFs: NodeFsBackend,
  path: PathLike | undefined,
  options: ReadStreamOptions = {},
  runLeaf?: AsyncLeafRunner,
  lifetime?: DescriptorLifetime,
) {
  return new NodeFsReadStream(kernelFs, path, options, runLeaf, lifetime);
}

export function createWriteStream(
  kernelFs: NodeFsBackend,
  path: PathLike | undefined,
  options: WriteStreamOptions = {},
  runLeaf?: AsyncLeafRunner,
  lifetime?: DescriptorLifetime,
) {
  return new NodeFsWriteStream(kernelFs, path, options, runLeaf, lifetime);
}
