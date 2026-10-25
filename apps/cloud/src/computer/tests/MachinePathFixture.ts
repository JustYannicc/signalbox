// @effect-diagnostics nodeBuiltinImport:off - native regression reads only hash-pinned local WASM.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import {
  KERNEL_BASH_ARTIFACT,
  type KernelBashCredentials,
} from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelCommand, KernelCommandForwarder } from "../../kernel/KernelCommandForwarder.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import type { ChildCoreutilsCommand } from "../ChildProgramSet.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import { createProductComputer } from "../ProductComputer.ts";
import type { MachineFilesPort } from "../MachineFilesPort.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { controlledMachineFiles } from "./MachinePathControlledFiles.ts";
import { observe, recordingChild, trackSqlWrites } from "./MachinePathFixtureSupport.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";

const directory =
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_PROGRAM_DIR ??
  new URL("../../../../../.t3/1071/programs/", import.meta.url).pathname;
const available = NodeFS.existsSync(NodePath.join(directory, "bash.wasm"));
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error(`Required GNU Bash test artifact is missing: ${directory}/bash.wasm`);
export const bashModule = available ? loadBash(directory) : undefined;

type RunningBashHost = KernelBashPort & {
  readonly metadata: () => {
    readonly pid: number;
    readonly credentials: KernelBashCredentials;
  };
};

function loadBash(root: string) {
  const bytes = NodeFS.readFileSync(NodePath.join(root, "bash.wasm"));
  if (
    bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("Machine PATH regression requires the pinned public Bash");
  return new WebAssembly.Module(bytes);
}

const machineCommands = [
  "awk",
  "bash",
  "cat",
  "cp",
  "env",
  "echo",
  "find",
  "git",
  "git-remote-https",
  "grep",
  "head",
  "jq",
  "ls",
  "mkdir",
  "mv",
  "python3",
  "printf",
  "pwd",
  "rg",
  "rm",
  "sed",
  "sh",
  "sort",
  "tail",
  "touch",
  "uniq",
  "wc",
  "which",
  "xargs",
] as const;

export const machinePathInventory = machineInventoryFixture([
  ...machineCommands.flatMap((name) =>
    ["/bin", "/usr/bin"].map((directory) => ({
      path: `${directory}/${name}`,
      mode: 0o755,
      uid: 0,
      gid: 0,
    })),
  ),
  { path: "/usr/lib/git-core/git-remote-https", mode: 0o755, uid: 0, gid: 0 },
]);

export interface MachinePathFixtureOptions {
  readonly threadId?: string;
  readonly home?: string;
  readonly inventory?: MachineProgramInventory;
  readonly files?: MachineFilesPort;
  readonly coreutilsModules?: Partial<Record<ChildCoreutilsCommand, WebAssembly.Module>>;
  readonly spawn?: KernelCommandForwarder["spawn"];
  readonly before?: (filesystem: KernelFileSystem) => void;
}

let nextThread = 0;

export function machinePathFixture(
  module: WebAssembly.Module,
  options: MachinePathFixtureOptions = {},
) {
  const database = sqliteFixture();
  let sqlWrites = 0;
  const storageSource = database.storage;
  const storage = createFacetSqliteStorage(
    trackSqlWrites(storageSource, (query) => {
      if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM)\b/i.test(query))
        sqlWrites += 1;
    }),
    () => 1n,
  );
  const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials, umask: 0o022 },
  });
  filesystem.mkdir("/workspace");
  filesystem.chdir("/workspace");
  options.before?.(filesystem);

  const wakes = new KernelWakeRegistry();
  const machineCalls: KernelCommand[] = [];
  const localCalls: string[] = [];
  const inventory = options.inventory ?? machinePathInventory;
  const controlled = options.files === undefined ? controlledMachineFiles(inventory) : undefined;
  const files = options.files ?? controlled!.files;
  const home = options.home ?? "/workspace";
  const code = (name: string) => ({
    mainModule: `${name}.js`,
    modules: { [`${name}.js`]: "export default class {}" },
  });
  const loader: ChildWorkerLoaderPort = {
    async run(input, invocation) {
      const port = invocation as unknown as {
        host<T>(): T;
        stopped(): void;
      };
      localCalls.push(input.command.executable);
      try {
        const basename = input.command.executable.slice(
          input.command.executable.lastIndexOf("/") + 1,
        );
        const coreutilsModule = options.coreutilsModules?.[basename as ChildCoreutilsCommand];
        if (coreutilsModule !== undefined) {
          return await createChildCoreutils({
            module: coreutilsModule,
            port: port.host<KernelCoreutilsPort>(),
            args: input.command.argv,
            env: input.command.env,
          }).run();
        }
        if (!Object.hasOwn(input.modules, "bash.js")) throw new Error("Unexpected guest body");
        const host = port.host<RunningBashHost>();
        const metadata = host.metadata();
        return await createChildBash({
          module,
          port: host,
          pid: metadata.pid,
          credentials: metadata.credentials,
          args: input.command.argv,
          env: input.command.env,
        }).run();
      } finally {
        port.stopped();
      }
    },
  };

  const machine: KernelCommandForwarder & { readonly files: MachineFilesPort } = {
    files,
    async spawn(command, signal) {
      machineCalls.push(structuredClone(command));
      if (options.spawn !== undefined) return options.spawn(command, signal);
      return recordingChild();
    },
  };
  const computer = createProductComputer({
    threadId: options.threadId ?? `machine-path-regression-${nextThread++}`,
    filesystem,
    wakes,
    capacity: new ChildWorkerCapacity(4),
    loader,
    programs: {
      bash: code("bash"),
      busyboxCat: code("cat"),
      busyboxApplets: code("busybox"),
      ripgrep: code("rg"),
      git: code("git"),
      sed: code("sed"),
      coreutils: Object.fromEntries(
        CHILD_COREUTILS_COMMANDS.map((name) => [name, code(name)]),
      ) as Record<(typeof CHILD_COREUTILS_COMMANDS)[number], ReturnType<typeof code>>,
    },
    machineInventory: inventory,
    machine: () => machine,
    signal: new AbortController().signal,
  });
  return {
    computer,
    filesystem,
    files,
    fileLookups: controlled?.calls ?? [],
    machineCalls,
    localCalls,
    sqlWriteCount: () => sqlWrites,
    async direct(executable: string, argv: readonly string[], path = "/bin:/usr/bin") {
      return observe(
        await computer.exec(
          {
            executable,
            argv,
            cwd: "/workspace",
            env: { HOME: home, PATH: path, LC_ALL: "C" },
          },
          new AbortController().signal,
          undefined,
        ),
      );
    },
    async run(command: string, path = "/bin:/usr/bin") {
      const child = await computer.exec(
        {
          executable: "/bin/bash",
          argv: ["bash", "--noprofile", "--norc", "-c", command],
          cwd: "/workspace",
          env: { HOME: home, PATH: path, LC_ALL: "C" },
        },
        new AbortController().signal,
        undefined,
      );
      return observe(child);
    },
    async close() {
      try {
        await computer.close();
      } finally {
        wakes.dispose();
        filesystem.dispose();
        database.close();
      }
    },
  };
}
