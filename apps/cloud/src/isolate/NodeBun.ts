import type { KernelProgramHost } from "../kernel/KernelProgramHost.ts";
import type { BunIsolateCapability, BunShimHost } from "./BunShim.ts";
import type { NodeFsModules } from "./NodeFs.ts";
import type { createNodeChildProcess } from "./NodeChildProcess.ts";
import type { createNodeProcess, NodeProcessStreams } from "./NodeProcess.ts";
import { createBunFileHost } from "./node/bunHost/files.ts";
import { createBunSpawn } from "./node/bunHost/spawn.ts";
import { toBunStdinReadable } from "./node/bunHost/streams.ts";
import { createBunWhich } from "./node/bunHost/which.ts";

export interface NodeBunHostOptions {
  readonly filesystem: NodeFsModules;
  readonly process: Pick<ReturnType<typeof createNodeProcess>, "cwd" | "env"> & NodeProcessStreams;
  readonly childProcess: Pick<ReturnType<typeof createNodeChildProcess>, "spawn">;
  readonly programHost: Pick<KernelProgramHost, "resolve">;
  readonly main: string;
  readonly version: string;
  readonly revision: string;
  readonly onMissing: BunShimHost["onMissing"];
  readonly capabilities?: Partial<Record<BunIsolateCapability, unknown>>;
}

/** Builds Bun's isolate host from the already-scoped Node filesystem and process adapters. */
export function createNodeBunHost(options: NodeBunHostOptions): BunShimHost {
  const which = createBunWhich(options.programHost, options.process);
  const stdin = toBunStdinReadable(options.process.stdin);

  return {
    files: createBunFileHost(options.filesystem),
    stdin,
    env: options.process.env,
    main: options.main,
    version: options.version,
    revision: options.revision,
    which,
    spawn: createBunSpawn(options.childProcess, options.process, which),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    onMissing: options.onMissing,
  };
}
