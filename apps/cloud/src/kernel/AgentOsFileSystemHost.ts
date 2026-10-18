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
    this.imports = new AgentOsFileSystemOperations(options).imports;
  }

  getImportObject(): { host_fs: Record<string, unknown> } {
    return { host_fs: { ...this.imports } };
  }
}
