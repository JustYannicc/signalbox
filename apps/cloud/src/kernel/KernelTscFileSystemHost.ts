import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelTscFileSystemPort } from "./KernelTscFileSystem.ts";
import { KernelTscKernelFileSystem } from "./tsc/KernelTscKernelFileSystem.ts";

export function createKernelTscFileSystem(filesystem: KernelFileSystem): KernelTscFileSystemPort {
  return new KernelTscKernelFileSystem(filesystem);
}
