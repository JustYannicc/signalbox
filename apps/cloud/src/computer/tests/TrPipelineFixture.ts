// @effect-diagnostics nodeBuiltinImport:off - Executes only hash-pinned local product WASM artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { KernelForwardingUnavailable } from "../../kernel/KernelCommandForwarder.ts";
import { vi } from "vite-plus/test";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createProductComputer } from "../ProductComputer.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { commandProgramCodes, readAll } from "../commandGatewayTesting.ts";
import { emptyMachineFilesFixture, machineInventoryFixture } from "../machineInventoryTesting.ts";
import { sqliteFixture } from "../sqliteTesting.ts";
import { bashCredentials } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const coreutils = JSON.parse(
  NodeFS.readFileSync(
    new URL("../../../infra/kernelPrograms/coreutils/provenance.json", import.meta.url),
    "utf8",
  ),
) as { commands: Record<string, { bytes: number; sha256: string }> };
const paths = {
  bash:
    NodeProcess.env.SIGNALBOX_BASH_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url),
  ugrep:
    NodeProcess.env.SIGNALBOX_UGREP_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/ugrep.wasm", import.meta.url),
  busybox:
    NodeProcess.env.SIGNALBOX_BUSYBOX_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url),
  head:
    NodeProcess.env.SIGNALBOX_COREUTILS_HEAD_ARTIFACT ??
    new URL("../../../../../.t3/issue-1263/programs/coreutils/head.wasm", import.meta.url),
};
export const pipelineArtifactsAvailable = Object.values(paths).every((path) =>
  NodeFS.existsSync(path),
);
if (!pipelineArtifactsAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_TR_PIPELINE_ARTIFACTS === "1")
  throw new Error("The hydrated grep proof requires pinned Bash, ugrep, BusyBox and head WASM");
const pins = {
  bash: KERNEL_BASH_ARTIFACT,
  ugrep: KERNEL_UGREP_ARTIFACT,
  busybox: KERNEL_BUSYBOX_ARTIFACT,
  head: coreutils.commands.head!,
};

function program(name: keyof typeof paths) {
  const bytes = NodeFS.readFileSync(paths[name]);
  const pin = pins[name];
  if (
    bytes.length !== pin.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    throw new Error(`Pinned ${name} artifact does not match its provenance`);
  return {
    module: new WebAssembly.Module(bytes),
    code: {
      mainModule: `${name}.js`,
      modules: {
        [`${name}.js`]: "export default class {}",
        [`${name}.wasm`]: {
          wasm: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        },
      },
    },
  };
}

type BashHost = KernelBashPort & {
  metadata(): { pid: number; credentials: typeof bashCredentials; residentByteLimit: number };
  forkSnapshot(): Promise<KernelBashForkSource | undefined>;
};

export function pipelineFixture(files: Readonly<Record<string, string>>) {
  const programs = {
    bash: program("bash"),
    ugrep: program("ugrep"),
    busybox: program("busybox"),
    head: program("head"),
  };
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: bashCredentials, umask: 0o022 },
  });
  filesystem.mkdir("/work");
  filesystem.chdir("/work");
  for (const [path, content] of Object.entries(files)) {
    const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY, 0o644);
    filesystem.write(fd, new TextEncoder().encode(content), null);
    filesystem.close(fd);
  }
  const controller = new AbortController();
  const executables = new Map<number, string>();
  const commands: { executable: string; cwd: string; argv: readonly string[] }[] = [];
  const machineSpawn = vi.fn(async () => {
    controller.abort(new Error("The pipeline unexpectedly requested a machine"));
    throw new KernelForwardingUnavailable("RUNNER_NOT_READY", "No machine is attached");
  });
  const loader: ChildWorkerLoaderPort = {
    async run(input, target) {
      commands.push(input.command);
      const invocation = target as unknown as { host(): object | Promise<object>; stopped(): void };
      const host = await invocation.host();
      try {
        const { executable, argv: args, env } = input.command;
        if (executable === "/bin/bash") {
          const port = host as BashHost;
          const bash = createChildBash({
            module: programs.bash.module,
            ...port.metadata(),
            port,
            args,
            env,
            snapshot: await port.forkSnapshot(),
          });
          try {
            return await bash.run();
          } finally {
            await bash.drain();
          }
        }
        if (["/bin/grep", "/bin/cat", "/bin/tr", "/bin/yes"].includes(executable)) {
          const port = host as KernelBusyboxPort;
          const identity = await port.callBusybox({
            name: "identity",
            args: [2],
            memorySize: 0,
            regions: [],
          });
          executables.set(identity.value, executable);
          return await createChildBusybox({
            module: executable === "/bin/grep" ? programs.ugrep.module : programs.busybox.module,
            port,
            args,
            env,
          }).run();
        }
        if (executable === "/bin/head")
          return await createChildCoreutils({
            module: programs.head.module,
            port: host as KernelCoreutilsPort,
            args,
            env,
          }).run();
        throw new Error(`Unexpected product child ${executable}`);
      } finally {
        invocation.stopped();
      }
    },
  };
  const codes = commandProgramCodes();
  const computer = createProductComputer({
    threadId: "tr-pipelines",
    filesystem,
    wakes,
    signal: controller.signal,
    loader,
    capacity: new ChildWorkerCapacity(8, {
      owner: "test/tr-pipelines",
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    }),
    programs: {
      ...codes,
      bash: programs.bash.code,
      ugrep: programs.ugrep.code,
      busyboxCat: programs.busybox.code,
      busyboxApplets: programs.busybox.code,
      coreutils: { ...codes.coreutils, head: programs.head.code },
    },
    machineInventory: machineInventoryFixture(
      ["bash", "grep", "head", "cat", "tr", "yes"].map((name) => ({
        path: `/bin/${name}`,
        mode: 0o755,
        uid: 0,
        gid: 0,
      })),
    ),
    machine: () => ({ files: emptyMachineFilesFixture(), spawn: machineSpawn }),
  });
  const signals: { executable: string | undefined; signal: number }[] = [];
  const generateSignal = computer.processes.generateSignal.bind(computer.processes);
  vi.spyOn(computer.processes, "generateSignal").mockImplementation((handle, signal) => {
    const info = computer.processes.info(handle);
    signals.push({
      executable: info.status === "ok" ? executables.get(info.value.pid) : undefined,
      signal,
    });
    return generateSignal(handle, signal);
  });
  return {
    commands,
    machineSpawn,
    signals,
    async run(script: string) {
      const child = await computer.exec(
        {
          executable: "/bin/bash",
          argv: ["bash", "--noprofile", "--norc", "-c", script],
          cwd: "/work",
          env: { HOME: "/work", PATH: "/bin", LC_ALL: "C", PWD: "/work" },
        },
        controller.signal,
        undefined,
      );
      try {
        await child.stdin.close();
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          readAll(child.stdout),
          readAll(child.stderr),
        ]);
        await computer.drain();
        return {
          status,
          stdout: new TextDecoder().decode(stdout),
          stderr: new TextDecoder().decode(stderr),
        };
      } finally {
        await child.dispose();
      }
    },
    async close() {
      await computer.close();
      filesystem.dispose();
      wakes.dispose();
      database.close();
    },
  };
}
