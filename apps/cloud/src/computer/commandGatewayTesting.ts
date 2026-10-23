import { vi } from "vite-plus/test";
import type { AgentOsSpawnRequest } from "../kernel/AgentOsProcessWire.ts";
import type { KernelResult } from "../kernel/KernelAbi.ts";
import type { KernelCpuAccounting } from "../kernel/KernelCpuAccounting.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandExit,
  KernelCommandForwarder,
} from "../kernel/KernelCommandForwarder.ts";
import type { KernelSyscallRequest, KernelSyscallResponse } from "../kernel/KernelSyscallPort.ts";
import { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import { createCommandGateway, type CommandProgramCodes } from "./CommandGateway.ts";
import { CHILD_COREUTILS_COMMANDS } from "./ChildProgramSet.ts";
import type { ChildWorkerInvocation } from "./ChildWorkerProgram.ts";
import type { ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import { childBusyboxFixture, exited } from "./childBusyboxTesting.ts";

export interface FakeChildInvocation {
  readonly host: <T extends object>() => Promise<T>;
  readonly acknowledge: () => void;
}

export type FakeChildRun = (
  input: ChildWorkerInvocation,
  invocation: FakeChildInvocation,
) => Promise<KernelCommandExit>;

export interface CommandGatewayFixtureOptions {
  readonly run?: FakeChildRun;
  readonly orderedMachineRules?: readonly {
    readonly id: string;
    readonly executable: string;
    readonly argvPrefix?: readonly string[];
    readonly minimumWorkspaceBytes?: number;
  }[];
  readonly capacityLimit?: number;
  readonly cpuAccounting?: KernelCpuAccounting;
}

export function commandGatewayFixture(options: CommandGatewayFixtureOptions = {}) {
  const kernel = childBusyboxFixture();
  const capacity = new ChildWorkerCapacity(options.capacityLimit ?? 2);
  const run =
    options.run ??
    (async (_input, invocation) => {
      invocation.acknowledge();
      return exited();
    });
  const loader: ChildWorkerLoaderPort = {
    async run(input, target) {
      const candidate = target as unknown as {
        host?: () => unknown;
        stopped?: () => void;
      };
      if (typeof candidate.host !== "function" || typeof candidate.stopped !== "function") {
        throw new Error("Typed child loader omitted its host capability or stop acknowledgement");
      }
      let acknowledged = false;
      const invocation: FakeChildInvocation = {
        async host<T extends object>() {
          return (await candidate.host!()) as T;
        },
        acknowledge() {
          if (acknowledged) return;
          acknowledged = true;
          candidate.stopped!();
        },
      };
      return run(input, invocation);
    },
  };
  const machineChild = emptyChild();
  const machineSpawn = vi.fn(async (_command: KernelCommand, _signal: AbortSignal) => machineChild);
  const machine: KernelCommandForwarder = { spawn: machineSpawn };
  const gateway = createCommandGateway({
    filesystem: kernel.filesystem,
    processes: kernel.context.processes,
    wakes: kernel.context.wakes,
    capacity,
    loader,
    programs: programCodes(),
    hostname: "command-gateway-test",
    machine,
    ...(options.orderedMachineRules === undefined
      ? {}
      : { orderedMachineRules: options.orderedMachineRules }),
    home: "/guest/home",
    ...(options.cpuAccounting === undefined ? {} : { cpuAccounting: options.cpuAccounting }),
  });

  return {
    ...kernel,
    capacity,
    gateway,
    machineSpawn,
    machineChild,
    async close() {
      await gateway.close();
      await kernel.close();
    },
  };
}

export function spawnRequest(
  executable: string,
  options: {
    readonly argv?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly actions?: AgentOsSpawnRequest["actions"];
  } = {},
): AgentOsSpawnRequest {
  return {
    execPath: executable,
    argv: options.argv ?? ["custom-argv0", "snow雪"],
    env: options.env ?? { EXACT: "only", EMPTY: "" },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    actions: options.actions ?? [],
    pidPointer: 0,
    attributes: {
      flags: 0,
      defaultMask: { low: 0, high: 0 },
      signalMask: { low: 0, high: 0 },
      processGroup: 0,
    },
  };
}

export async function writeStdio(
  port: { call(request: KernelSyscallRequest): Promise<KernelSyscallResponse> },
  fd: 1 | 2,
  bytes: Uint8Array,
) {
  const iovec = new Uint8Array(8);
  const view = new DataView(iovec.buffer);
  view.setUint32(0, 16, true);
  view.setUint32(4, bytes.byteLength, true);
  const response = await port.call({
    name: "fd_write",
    args: [fd, 0, 1, 8],
    memorySize: 64,
    regions: [
      { pointer: 0, bytes: iovec },
      { pointer: 8, bytes: new Uint8Array(4) },
      { pointer: 16, bytes },
    ],
  });
  if (response.kind !== "return" || response.value !== 0) {
    throw new Error(`fd_write failed for descriptor ${fd}`);
  }
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function emptyChild(
  options: {
    readonly stdout?: Uint8Array;
    readonly stderr?: Uint8Array;
    readonly exited?: Promise<KernelCommandExit>;
    readonly signal?: (signal: number) => Promise<KernelResult<void>>;
  } = {},
): KernelCommandChild {
  const stream = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes.slice());
        controller.close();
      },
    });
  return {
    stdin: new WritableStream<Uint8Array>(),
    stdout: stream(options.stdout ?? new Uint8Array()),
    stderr: stream(options.stderr ?? new Uint8Array()),
    exited: options.exited ?? Promise.resolve(exited()),
    signal: options.signal ?? (async () => ({ status: "ok", value: undefined })),
    dispose: async () => {},
  };
}

function programCodes(): CommandProgramCodes {
  const code = (name: string) => ({
    mainModule: `${name}.js`,
    modules: { [`${name}.js`]: "export default class {}" },
  });
  const coreutils = Object.fromEntries(
    CHILD_COREUTILS_COMMANDS.map((command) => [command, code(`coreutils-${command}`)]),
  ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], ReturnType<typeof code>>;
  return {
    bash: code("bash"),
    busyboxCat: code("busybox-cat"),
    busyboxApplets: code("busybox-applets"),
    sed: code("gnu-sed"),
    ripgrep: code("ripgrep"),
    coreutils,
    git: code("git"),
  };
}

export { exited } from "./childBusyboxTesting.ts";
