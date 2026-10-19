import * as NodeProcess from "node:process";
import { KernelCpuAccounting } from "../../src/kernel/KernelCpuAccounting.ts";
import { createBunShim, type BunFileTarget } from "../../src/isolate/BunShim.ts";
import { createNodeBunHost } from "../../src/isolate/NodeBun.ts";
import { createNodeChildProcess } from "../../src/isolate/NodeChildProcess.ts";
import {
  createNodeProcess,
  type NodeProcessEnvironment,
  type NodeProcessStreams,
  type NodeRuntimeIdentity,
} from "../../src/isolate/NodeProcess.ts";
import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import type { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createProofProgramHost, type ProofProgramModules } from "./proofPrograms.ts";

const capturedMonotonicNowNs = NodeProcess.hrtime.bigint.bind(NodeProcess.hrtime);

/** Builds Node, child_process and Bun from one request-owned kernel host and filesystem. */
export function createProofProgramRuntime(options: {
  readonly filesystem: KernelFileSystem;
  readonly fs: NodeFsModules;
  readonly wakes: KernelWakeRegistry;
  readonly modules?: ProofProgramModules;
  readonly env: NodeProcessEnvironment;
  readonly identity: NodeRuntimeIdentity;
  readonly streams: NodeProcessStreams;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly isSeeded: () => boolean;
  readonly onMissing: (member: string) => void;
}) {
  const cpuAccounting = new KernelCpuAccounting(capturedMonotonicNowNs);
  const kernelHost = createProofProgramHost({
    cpuAccounting,
    filesystem: options.filesystem,
    wakes: options.wakes,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  });
  const execution = kernelHost.cpuExecution;
  if (!execution) throw new Error("Configured kernel host omitted CPU execution accounting");
  const cpuRoot = execution.root;
  const root = kernelHost.processes.info();
  if (root.status !== "ok") throw new Error("Kernel root process identity is unavailable");
  const owner = options.filesystem.posixCredentials;
  if (owner === undefined) throw new Error("Proof filesystem has no POSIX owner policy");
  if (options.identity.user === undefined) throw new Error("Proof Node identity has no user");
  const identity = Object.freeze({
    ...options.identity,
    user: {
      ...options.identity.user,
      uid: owner.uid,
      gid: owner.gid,
    },
    pid: root.value.pid,
    ppid: root.value.parentPid,
  });
  const processContext = {
    filesystem: options.filesystem,
    env: options.env,
    identity,
    streams: options.streams,
    processes: kernelHost.processes,
    cpuAccounting: cpuRoot,
  };
  const process = createNodeProcess(processContext);
  const childProcess = createNodeChildProcess(kernelHost, {
    filesystem: options.filesystem,
    env: options.env,
  });
  const bunHost = createNodeBunHost({
    filesystem: options.fs,
    process,
    childProcess,
    programHost: kernelHost,
    main: "/$bunfs/root/cli",
    version: "1.3.11",
    revision: "signalbox-workerd",
    onMissing: options.onMissing,
  });
  const files = bunHost.files;
  if (files === undefined) throw new Error("Node Bun host omitted its canonical file adapter");
  const bun = createBunShim({
    ...bunHost,
    files: {
      ...files,
      async readFile(target: BunFileTarget) {
        if (
          typeof target === "string" &&
          Object.hasOwn(options.assets, target) &&
          !options.isSeeded()
        ) {
          throw Object.assign(new Error(`Diagnostic asset bytes not seeded: ${target}`), {
            code: "ERR_DIAGNOSTIC_ASSET_UNSEEDED",
          });
        }
        return files.readFile(target);
      },
    },
  }).bun;
  return { kernelHost, processContext, process, childProcess, bun, cpuRoot };
}
