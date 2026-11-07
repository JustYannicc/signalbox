// @effect-diagnostics nodeBuiltinImport:off - Executes only hash-pinned local product WASM artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import { createMemoryFilePersistencePorts } from "../../kernel/MemoryFilePersistencePorts.ts";
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
import { bashCredentials, exited } from "./ChildBashFixture.ts";

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
const available = Object.values(paths).every((path) => NodeFS.existsSync(path));
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_GREP_HYDRATION_ARTIFACTS === "1")
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

const prefix = "# Context\n## Section\n### Detail\n**bold**\nx control\n";
const contents = prefix + "z".repeat(9_364 - prefix.length - 1) + "\n";

describe.skipIf(!available)("hydrated paths through ProductComputer Bash and grep", () => {
  it.each([
    {
      script: String.raw`exec 3<CONTEXT.md; grep -n "^## \|^### \|^\*\*" CONTEXT.md | head -80`,
      stdout: "2:## Section\n3:### Detail\n4:**bold**\n",
      children: ["/bin/grep", "/bin/head"],
    },
    {
      script: String.raw`grep -n "^## \|^### \|^\*\*" CONTEXT.md | head -80`,
      stdout: "2:## Section\n3:### Detail\n4:**bold**\n",
      children: ["/bin/grep", "/bin/head"],
    },
    {
      script: "exec 3<CONTEXT.md; grep -n x /work/CONTEXT.md",
      stdout: "1:# Context\n5:x control\n",
      children: ["/bin/grep"],
    },
    { script: "exec 3<CONTEXT.md; cat CONTEXT.md", stdout: contents, children: ["/bin/cat"] },
    {
      script: "grep -n x /work/CONTEXT.md",
      stdout: "1:# Context\n5:x control\n",
      children: ["/bin/grep"],
    },
    { script: "cat CONTEXT.md", stdout: contents, children: ["/bin/cat"] },
    {
      script: "exec 3<CONTEXT.md; grep -n x /dev/fd/3",
      stdout: "1:# Context\n5:x control\n",
      children: ["/bin/grep"],
    },
    {
      script: "exec 7<CONTEXT.md; grep -n x input",
      stdout: "1:# Context\n5:x control\n",
      children: ["/bin/grep"],
    },
    {
      script: "exec 7<CONTEXT.md; grep -n x /dev/fd/7",
      stdout: "1:# Context\n5:x control\n",
      children: ["/bin/grep"],
    },
    {
      script: "PWD=/ grep -n x CONTEXT.md",
      stdout: "1:# Context\n5:x control\n",
      children: ["/bin/grep"],
    },
  ])("opens the hydrated file with $script", async ({ script, stdout, children }) => {
    const programs = {
      bash: program("bash"),
      ugrep: program("ugrep"),
      busybox: program("busybox"),
      head: program("head"),
    };
    const database = sqliteFixture();
    const wakes = new KernelWakeRegistry();
    const ports = createMemoryFilePersistencePorts();
    const at = { repository: "grep-hydration", fork: "test", commit: "initial" };
    ports.seedFile(at, "/work/CONTEXT.md", new TextEncoder().encode(contents));
    const persistence = createFacetFilePersistence(database.storage, () => 1n, { wakes, ports });
    persistence.storage.posix.initialize(persistence.storage.root, {
      mode: 0o755,
      uid: 1000,
      gid: 1000,
    });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: persistence.storage }],
      posix: { credentials: bashCredentials, umask: 0o022 },
    });
    filesystem.mkdir("/work");
    filesystem.chdir("/work");
    filesystem.symlink("/dev/fd/7", "input");
    const controller = new AbortController();
    const commands: { executable: string; cwd: string; argv: readonly string[] }[] = [];
    const machineSpawn = vi.fn(async () => {
      throw new Error("Hydrated grep must stay in the isolate");
    });
    const loader: ChildWorkerLoaderPort = {
      async run(input, target) {
        commands.push(input.command);
        const invocation = target as unknown as {
          host(): object | Promise<object>;
          stopped(): void;
        };
        const host = await invocation.host();
        try {
          const { executable, argv: args, env } = input.command;
          if (executable === "/bin/bash") {
            const port = host as BashHost;
            const metadata = port.metadata();
            const bash = createChildBash({
              module: programs.bash.module,
              ...metadata,
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
          if (executable === "/bin/grep" || executable === "/bin/cat") {
            const port = host as KernelBusyboxPort;
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
      threadId: "grep-hydrated-paths",
      filesystem,
      wakes,
      signal: controller.signal,
      loader,
      capacity: new ChildWorkerCapacity(4, {
        owner: "test/grep-hydrated-paths",
        RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      }),
      programs: {
        ...codes,
        bash: programs.bash.code,
        ugrep: programs.ugrep.code,
        busyboxCat: programs.busybox.code,
        coreutils: { ...codes.coreutils, head: programs.head.code },
      },
      machineInventory: machineInventoryFixture(
        ["bash", "grep", "head", "cat"].map((name) => ({
          path: `/bin/${name}`,
          mode: 0o755,
          uid: 0,
          gid: 0,
        })),
      ),
      machine: () => ({ files: emptyMachineFilesFixture(), spawn: machineSpawn }),
    });
    let child: Awaited<ReturnType<typeof computer.exec>> | undefined;
    try {
      const fd = filesystem.open(
        "/work/CONTEXT.md",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
        0o644,
      );
      filesystem.ftruncate(fd, 9_364n);
      const inode = filesystem.fstat(fd).ino;
      filesystem.close(fd);
      persistence.markUnhydrated({ inode, path: "/work/CONTEXT.md", at, size: 9_364n });
      await persistence.runLeaf(
        () => persistence.storage.readInto(inode, 0n, new Uint8Array(9_364)),
        controller.signal,
      );
      expect(ports.fetchCalls).toMatchObject([{ paths: ["/work/CONTEXT.md"], status: "ok" }]);
      expect(filesystem.lstat("/work/CONTEXT.md")).toMatchObject({ type: "file", size: 9_364n });
      expect(persistence.storage.posix.get(inode).mode & 0o777).toBe(0o644);
      expect(filesystem.cwd).toBe("/work");
      child = await computer.exec(
        {
          executable: "/bin/bash",
          argv: ["bash", "--noprofile", "--norc", "-c", script],
          cwd: "/work",
          env: { HOME: "/work", PATH: "/bin", LC_ALL: "C", PWD: "/work" },
        },
        controller.signal,
        undefined,
      );
      await child.stdin.close();
      const [status, output, errors] = await Promise.all([
        child.exited,
        readAll(child.stdout),
        readAll(child.stderr),
      ]);
      await computer.drain();
      expect({
        status,
        stdout: new TextDecoder().decode(output),
        stderr: new TextDecoder().decode(errors),
        commands: commands.map(({ executable, cwd }) => ({ executable, cwd })),
      }).toMatchObject({
        status: exited(),
        stdout,
        stderr: "",
      });
      expect(commands.map(({ executable }) => executable)).toEqual(
        expect.arrayContaining(["/bin/bash", ...children]),
      );
      expect(commands.every(({ cwd }) => cwd === "/work")).toBe(true);
      expect(machineSpawn).not.toHaveBeenCalled();
      expect(filesystem.cwd).toBe("/work");
    } finally {
      await child?.dispose();
      await computer.close();
      filesystem.dispose();
      persistence.dispose();
      wakes.dispose();
      database.close();
    }
  });
});
