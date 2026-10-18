import { createAgentOsHostFsArgumentTransform } from "./AgentOsWasi.ts";
import {
  AgentOsFileSystemOperations,
  type AgentOsFileSystemHostOptions,
} from "./filesystem/AgentOsFileSystemOperations.ts";

export type { AgentOsFileSystemHostOptions } from "./filesystem/AgentOsFileSystemOperations.ts";

/** AgentOS filesystem imports backed by the thread's shared WASI filesystem. */
export class AgentOsFileSystemHost {
  readonly imports: AgentOsFileSystemOperations["imports"];
  readonly suspendingImports = Object.freeze([] as string[]);

  constructor(options: AgentOsFileSystemHostOptions) {
    const operations = new AgentOsFileSystemOperations(options);
    if (options.agentOsPreopens !== true) {
      this.imports = operations.imports;
      return;
    }

    const transform = createAgentOsHostFsArgumentTransform(options.fileSystem);
    this.imports = Object.freeze({
      ...operations.imports,
      chmod: wrapImport("chmod", operations.imports.chmod, transform),
      fd_link: wrapImport("fd_link", operations.imports.fd_link, transform),
      open_tmpfile: wrapImport("open_tmpfile", operations.imports.open_tmpfile, transform),
      path_access: wrapImport("path_access", operations.imports.path_access, transform),
      path_blocks: wrapImport("path_blocks", operations.imports.path_blocks, transform),
      path_chown: wrapImport("path_chown", operations.imports.path_chown, transform),
      path_mode: wrapImport("path_mode", operations.imports.path_mode, transform),
      path_owner: wrapImport("path_owner", operations.imports.path_owner, transform),
      path_size: wrapImport("path_size", operations.imports.path_size, transform),
    });
  }

  getImportObject(): { host_fs: Record<string, unknown> } {
    return { host_fs: { ...this.imports } };
  }
}

function wrapImport<T extends (...args: never[]) => unknown>(
  name: string,
  operation: T,
  transform: (name: string, args: readonly (number | bigint)[]) => readonly (number | bigint)[],
): T {
  return ((...args: Parameters<T>) =>
    operation(...(transform(name, args) as unknown as Parameters<T>))) as T;
}
