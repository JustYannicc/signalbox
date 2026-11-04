// @effect-diagnostics nodeBuiltinImport:off - reads the retained, hash-pinned ripgrep module only.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { createComputerCommands } from "../../computer/ComputerCommands.ts";
import { createChildProgramCatalog } from "../../computer/ChildProgramCatalog.ts";
import { ChildWorkerCapacity } from "../../computer/ChildWorkerCapacity.ts";
import { createChildWasi } from "../../computer/ChildWasi.ts";
import type { ChildWorkerLoaderPort } from "../../computer/WorkerLoaderDispatch.ts";
import type { KernelSyscallPort } from "../../kernel/KernelSyscallPort.ts";
import { KernelProgramRegistry, KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import {
  KERNEL_RIPGREP_ARTIFACT,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
  createKernelRipgrepProgram,
} from "../../kernel/KernelRipgrepProgram.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";
import { createNodeChildProcess } from "../NodeChildProcess.ts";
import { createNodeFs } from "../NodeFs.ts";
import { sqliteFixture } from "./sqliteFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = process.env.SIGNALBOX_RIPGREP_ARTIFACT;

it
  .skipIf(artifact === undefined)
  .each(
    (["worker", "inline-async", "inline-sync"] as const).flatMap((route) =>
      ["/dev/fd/3", "/proc/self/fd/3"].map((path) => ({ route, path })),
    ),
  )("runs pinned ripgrep against $path through $route", async ({ route, path }) => {
  const bytes = NodeFS.readFileSync(artifact!);
  expect(bytes.length).toBe(KERNEL_RIPGREP_ARTIFACT.bytes);
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
    KERNEL_RIPGREP_ARTIFACT.sha256,
  );
  const module = new WebAssembly.Module(bytes);
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 0, gid: 0, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 0, gid: 0, euid: 0, egid: 0, groups: [0] }, umask: 0o022 },
  });
  filesystem.mkdir("/workspace");
  filesystem.chdir("/workspace");
  const registry = new KernelProgramRegistry();
  const code = { mainModule: "main.js", modules: { "main.js": "export default {};" } };
  const loader: ChildWorkerLoaderPort = {
    async run(input, invocation) {
      assertInvocation(invocation);
      try {
        const wasi = createChildWasi({
          module,
          syscalls: invocation.host(),
          args: input.command.argv,
          env: input.command.env,
        });
        const instance = new WebAssembly.Instance(module, wasi.imports);
        wasi.bind(instance);
        return await wasi.startProcess(instance);
      } finally {
        invocation.stopped();
      }
    },
  };
  const catalog = createChildProgramCatalog({
    registry,
    filesystem,
    loader,
    capacity: new ChildWorkerCapacity(1, {
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      owner: "test/inherited-fd-ripgrep",
    }),
    programs: { bash: code, busyboxCat: code, ripgrep: code },
    hostname: "inherited-fd-test",
  });
  if (route !== "worker")
    catalog.bindings.set("/bin/rg", {
      manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
      implementation: createKernelRipgrepProgram({ module }),
    });
  const host = new KernelProgramHost({ registry, wakes, programs: catalog.bindings });
  const computer = createComputerCommands({
    mode: "admitted",
    kernel: { host, filesystem },
    isolateKernel: { host, filesystem },
  });
  const fs = createNodeFs(filesystem).fs;
  try {
    fs.writeFileSync("/workspace/target.txt", "before\nneedle\nafter\n");
    const fd = fs.openSync("/workspace/target.txt", "r");
    if (route === "inline-sync") {
      const result = createNodeChildProcess(host, {
        filesystem,
        env: { PATH: "/bin", HOME: "/workspace" },
      }).spawnSync("/bin/rg", ["-n", "needle", path], { stdio: ["pipe", "pipe", "pipe", fd] });
      fs.closeSync(fd);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr?.toString()).toBe("");
      expect(result.stdout?.toString()).toBe("2:needle\n");
      return;
    }
    const child = createNodeComputerChildProcess(
      host,
      { filesystem, env: { PATH: "/bin", HOME: "/workspace" } },
      computer,
    ).spawn("/bin/rg", ["-n", "needle", path], {
      stdio: ["pipe", "pipe", "pipe", fd],
    });
    fs.closeSync(fd);
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));
    const closed = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    child.stdin?.end();
    await closed;
    expect(Buffer.concat(stderr).toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(Buffer.concat(stdout).toString()).toBe("2:needle\n");
  } finally {
    await host.processes.dispose();
    await catalog.drain();
    filesystem.dispose();
    wakes.dispose();
    database.close();
  }
});

function assertInvocation(
  value: object,
): asserts value is { host(): KernelSyscallPort; stopped(): void } {
  if (
    !("host" in value) ||
    typeof value.host !== "function" ||
    !("stopped" in value) ||
    typeof value.stopped !== "function"
  )
    throw new Error("Missing syscall host");
}
