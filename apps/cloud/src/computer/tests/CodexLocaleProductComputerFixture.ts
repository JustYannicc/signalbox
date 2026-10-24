// @effect-diagnostics nodeBuiltinImport:off - native fixture loads only pinned local WASM programs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import type { KernelBashCredentials } from "../../kernel/KernelBashProgram.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import type { KernelGitPort } from "../../kernel/KernelGitPort.ts";
import { KERNEL_GIT_ARTIFACT } from "../../kernel/KernelGitProgram.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import type { KernelCommand, KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";
import {
  KernelFileSystem,
  KernelOpenFlags,
  type KernelPosixMetadata,
} from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createProductComputer } from "../ProductComputer.ts";
import type { ProductComputerOptions } from "../ProductComputer.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { ChildWorkerCode } from "../ChildWorkerProgram.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildGit } from "../ChildGit.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelCommandForwarder } from "../../kernel/KernelCommandForwarder.ts";
import { emptyMachineFilesFixture, machineInventoryFixture } from "../machineInventoryTesting.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";

// Codex 0.162.1's exact UNIFIED_EXEC_ENV array is pinned at
// https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/unified_exec/process_manager.rs#L93-L104.
// Keep PATH absent: it is not one of those ten entries.
export const CODEX_UNIFIED_EXEC_ENV = Object.freeze({
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  CODEX_CI: "1",
});

export interface CodexLocalePrograms {
  readonly bash: WebAssembly.Module;
  readonly busybox: WebAssembly.Module;
  readonly git: WebAssembly.Module;
  readonly gnuSed: WebAssembly.Module;
}

const programDirectory =
  NodeProcess.env.SIGNALBOX_CODEX_LOCALE_PROGRAM_DIR ??
  NodePath.resolve(import.meta.dirname, "../../../../../.t3/1071/programs");

export function loadCodexLocalePrograms(): CodexLocalePrograms | undefined {
  const pins = {
    bash: KERNEL_BASH_ARTIFACT,
    busybox: KERNEL_BUSYBOX_ARTIFACT,
    git: KERNEL_GIT_ARTIFACT,
    sed: KERNEL_GNU_SED_ARTIFACT,
  } as const;
  const paths = Object.fromEntries(
    Object.keys(pins).map((name) => [name, NodePath.join(programDirectory, `${name}.wasm`)]),
  ) as Record<keyof typeof pins, string>;
  const missing = Object.values(paths).filter((path) => !NodeFS.existsSync(path));
  if (missing.length > 0) {
    if (NodeProcess.env.SIGNALBOX_REQUIRE_CODEX_LOCALE_ARTIFACTS === "1") {
      throw new Error(`Pinned Codex locale programs are missing: ${missing.join(", ")}`);
    }
    return undefined;
  }

  const modules = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => {
      const bytes = NodeFS.readFileSync(path);
      const pin = pins[name as keyof typeof pins];
      if (
        bytes.byteLength !== pin.bytes ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
      ) {
        throw new Error(`Pinned Codex locale program does not match ${name}'s artifact pin`);
      }
      return [name, new WebAssembly.Module(bytes)];
    }),
  ) as Record<keyof typeof pins, WebAssembly.Module>;
  return {
    bash: modules.bash,
    busybox: modules.busybox,
    git: modules.git,
    gnuSed: modules.sed,
  };
}

type RunningProgramHost = {
  readonly metadata: () => { readonly pid: number; readonly credentials: KernelBashCredentials };
};

interface LoaderInvocation {
  host(): object;
  stopped(): void | Promise<void>;
}

function testCode(name: string): ChildWorkerCode {
  // This test loader replaces WorkerLoader only; each guest body below is a pinned real WASM module.
  const mainModule = `${name}.js`;
  return { mainModule, modules: { [mainModule]: "export default class {}" } };
}

export function createCodexLocaleProductComputer(
  programs: CodexLocalePrograms,
  options: {
    readonly directory?: KernelPosixMetadata;
    readonly file?: KernelPosixMetadata;
    readonly machine?: KernelCommandForwarder;
    readonly orderedMachineRules?: ProductComputerOptions["orderedMachineRules"];
  } = {},
) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1_800_000_000_000_000_001n);
  const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 } as const;
  storage.posix.initialize(storage.root, {
    uid: credentials.uid,
    gid: credentials.gid,
    mode: 0o755,
  });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials, umask: 0o022 },
  });
  for (const path of ["/workspace", "/tmp", "/home", "/home/codex", "/bin", "/usr"])
    filesystem.mkdir(path);
  filesystem.mkdir("/usr/bin");
  // Bash resolves registered executables through the canonical filesystem before ProductComputer dispatch.
  for (const path of [
    "/bin/bash",
    "/bin/cat",
    "/bin/grep",
    "/bin/sed",
    "/bin/touch",
    "/usr/bin/git",
  ]) {
    writeFile(filesystem, path, "", 0o755);
  }
  filesystem.chdir("/workspace");
  writeFile(filesystem, "/workspace/proof.txt", "BEFORE\n");
  for (const [path, owner] of [
    ["/workspace", options.directory],
    ["/workspace/proof.txt", options.file],
  ] as const) {
    if (owner === undefined) continue;
    const inode = filesystem.resolve(path).inode;
    storage.posix.chown(inode, owner);
    storage.posix.chmod(inode, owner.mode);
  }

  const wakes = new KernelWakeRegistry();
  const signal = new AbortController().signal;
  const machineCalls: KernelCommand[] = [];
  const machine: KernelCommandForwarder = {
    async spawn(command, signal) {
      machineCalls.push({ ...command, argv: [...command.argv], env: { ...command.env } });
      if (options.machine !== undefined) return options.machine.spawn(command, signal);
      throw new Error("Unexpected machine admission in the Codex locale regression");
    },
  };
  const loaderCommands: KernelCommand[] = [];
  const loaderGuestPrograms: string[] = [];
  const loaderGuestResults: Array<{ readonly executable: string; readonly exitCode: number }> = [];
  const loader: ChildWorkerLoaderPort = {
    async run(input, invocation) {
      const command = input.command;
      loaderCommands.push({ ...command, argv: [...command.argv], env: { ...command.env } });
      const guestProgram = ["bash", "git", "sed"].find((name) =>
        Object.hasOwn(input.modules, `${name}.js`),
      );
      if (guestProgram === undefined) {
        throw new Error(
          `ProductComputer selected an unexpected guest module for ${command.executable}`,
        );
      }
      loaderGuestPrograms.push(guestProgram);
      const host = (invocation as unknown as LoaderInvocation).host();
      let result: KernelCommandExit;
      try {
        switch (guestProgram) {
          case "bash": {
            const bashPort = host as KernelBashPort & RunningProgramHost;
            const metadata = bashPort.metadata();
            if (command.executable !== "/bin/bash") {
              throw new Error(`Unexpected Bash executable path: ${command.executable}`);
            }
            result = await createChildBash({
              module: programs.bash,
              credentials: metadata.credentials,
              pid: metadata.pid,
              port: bashPort,
              args: command.argv,
              env: command.env,
            }).run();
            break;
          }
          case "sed":
            if (command.executable !== "/bin/sed" && command.executable !== "sed") {
              throw new Error(`Unexpected GNU sed executable path: ${command.executable}`);
            }
            result = await createChildBusybox({
              module: programs.gnuSed,
              port: host as KernelBusyboxPort,
              args: command.argv,
              env: command.env,
            }).run();
            break;
          case "git":
            if (command.executable !== "/usr/bin/git" && command.executable !== "git") {
              throw new Error(`Unexpected Git executable path: ${command.executable}`);
            }
            result = await createChildGit({
              module: programs.git,
              port: host as KernelGitPort,
              args: command.argv,
              env: command.env,
            }).run();
            break;
          default:
            throw new Error(
              `Unexpected real guest in Codex locale regression: ${command.executable}`,
            );
        }
      } finally {
        await (invocation as unknown as LoaderInvocation).stopped();
      }
      loaderGuestResults.push({ executable: command.executable, exitCode: result.exitCode });
      return result;
    },
  };
  const programsByName = (name: string) => testCode(name);
  const computer = createProductComputer({
    threadId: "codex-locale-public-product-computer",
    filesystem,
    wakes,
    capacity: new ChildWorkerCapacity(4),
    loader,
    programs: {
      bash: programsByName("bash"),
      busyboxCat: programsByName("busybox-cat"),
      busyboxApplets: programsByName("busybox-applets"),
      ripgrep: programsByName("ripgrep"),
      coreutils: {
        echo: programsByName("echo"),
        printf: programsByName("printf"),
        ls: programsByName("ls"),
        mkdir: programsByName("mkdir"),
        rm: programsByName("rm"),
        cp: programsByName("cp"),
        mv: programsByName("mv"),
        pwd: programsByName("pwd"),
        head: programsByName("head"),
        tail: programsByName("tail"),
      },
      git: programsByName("git"),
      sed: programsByName("sed"),
    },
    machineInventory: machineInventoryFixture(),
    machine: () => ({
      ...machine,
      files: emptyMachineFilesFixture(),
    }),
    ...(options.orderedMachineRules === undefined
      ? {}
      : { orderedMachineRules: options.orderedMachineRules }),
    signal,
  });

  return {
    computer,
    filesystem,
    machineCalls,
    loaderCommands,
    loaderGuestPrograms,
    loaderGuestResults,
    readFile(path: string) {
      return readFile(filesystem, path);
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

function writeFile(filesystem: KernelFileSystem, path: string, text: string, mode = 0o644): void {
  const descriptor = filesystem.open(
    path,
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
    mode,
  );
  try {
    const bytes = new TextEncoder().encode(text);
    const written = filesystem.write(descriptor, bytes, null);
    if (written !== bytes.byteLength) throw new Error(`Short fixture write to ${path}`);
  } finally {
    filesystem.close(descriptor);
  }
}

function readFile(filesystem: KernelFileSystem, path: string): Uint8Array {
  const descriptor = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const size = Number(filesystem.fstat(descriptor).size);
    const bytes = new Uint8Array(size);
    const count = filesystem.read(descriptor, bytes, 0n);
    if (count !== size) throw new Error(`Short canonical read from ${path}`);
    return bytes;
  } finally {
    filesystem.close(descriptor);
  }
}
