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
import type { KernelCommand, KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createChildBash } from "../ChildBash.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CHILD_COREUTILS_COMMANDS, CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import { createProductComputer } from "../ProductComputer.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";
import { RUNNER_MACHINE_PROGRAM_INVENTORY as inventory } from "../MachineProgramInventory.ts";

const directory = NodeProcess.env.SIGNALBOX_MACHINE_PATH_PROGRAM_DIR;
export const bashModule = directory === undefined ? undefined : loadBash(directory);
function loadBash(root: string) {
  const bytes = NodeFS.readFileSync(NodePath.join(root, "bash.wasm"));
  if (
    bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("Machine PATH regression requires the pinned public Bash");
  return new WebAssembly.Module(bytes);
}

export function machinePathFixture(module: WebAssembly.Module) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials, umask: 0o022 },
  });
  for (const path of ["/workspace", "/bin", "/usr", "/usr/bin"]) filesystem.mkdir(path);
  for (const path of Object.values(CHILD_PROGRAM_PATHS)) {
    const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY, 0o755);
    filesystem.close(fd);
  }
  filesystem.chdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const machineCalls: KernelCommand[] = [];
  const localCalls: string[] = [];
  const code = (name: string) => ({
    mainModule: `${name}.js`,
    modules: { [`${name}.js`]: "export default class {}" },
  });
  const loader: ChildWorkerLoaderPort = {
    async run(input, invocation) {
      const port = invocation as unknown as {
        host(): KernelBashPort & {
          metadata(): { pid: number; credentials: KernelBashCredentials };
        };
        stopped(): void;
      };
      localCalls.push(input.command.executable);
      try {
        if (!Object.hasOwn(input.modules, "bash.js")) throw new Error("Unexpected guest body");
        const host = port.host();
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
  const computer = createProductComputer({
    threadId: "machine-path-regression",
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
    machine: () => ({
      inventory,
      image: inventory.image,
      async spawn(command) {
        machineCalls.push(structuredClone(command));
        // A recording forwarder consumes pipeline input and reports a distinctive machine exit.
        const drained = Promise.withResolvers<void>();
        return {
          stdin: new WritableStream<Uint8Array>({ close: () => drained.resolve() }),
          stdout: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
          stderr: new ReadableStream<Uint8Array>({ start: (stream) => stream.close() }),
          exited: drained.promise.then(() => ({ exitCode: 23, signal: 0, coreDumped: false })),
          signal: async () => ({ status: "ok", value: undefined }),
          dispose: async () => {},
        };
      },
    }),
    signal: new AbortController().signal,
  });
  return {
    computer,
    filesystem,
    machineCalls,
    localCalls,
    async direct(executable: string, argv: readonly string[], path = "/bin:/usr/bin") {
      return observe(
        await computer.exec(
          {
            executable,
            argv,
            cwd: "/workspace",
            env: { HOME: "/workspace", PATH: path, LC_ALL: "C" },
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
          env: { HOME: "/workspace", PATH: path, LC_ALL: "C" },
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

async function observe(child: KernelCommandChild) {
  try {
    await child.stdin.close();
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  } finally {
    await child.dispose();
  }
}
