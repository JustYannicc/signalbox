import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { describeInheritedFd } from "../../../kernel/KernelInheritedFds.ts";
import { unsupportedNodeOperation } from "../process/NodeError.ts";
import type { NormalizedSpawn } from "./arguments.ts";

export function withInheritedFds(
  spawn: NormalizedSpawn,
  filesystem: KernelFileSystem,
): NormalizedSpawn {
  const inheritedFds = spawn.stdio.flatMap((mode, childFd) => {
    if (childFd < 3 || typeof mode !== "number") return [];
    try {
      return [describeInheritedFd(filesystem, mode, childFd)];
    } catch {
      return unsupportedNodeOperation("child_process.stdio mode");
    }
  });
  return inheritedFds.length === 0 ? spawn : { ...spawn, inheritedFds };
}
