// @effect-diagnostics nodeBuiltinImport:off - reads a locally retained, hash-pinned WASM artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import { KernelProgramRegistry, callKernel } from "../../kernel/KernelAbi.ts";
import {
  createKernelRipgrepProgram,
  KERNEL_RIPGREP_ARTIFACT,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
} from "../../kernel/KernelRipgrepProgram.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { KernelProgramHost } from "../../kernel/KernelProgramHost.ts";
import type { KernelSyscallPort } from "../../kernel/KernelSyscallPort.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildProgramCatalog } from "../ChildProgramCatalog.ts";
import { createChildWasi } from "../ChildWasi.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifactPath =
  NodeProcess.env.SIGNALBOX_RIPGREP_ARTIFACT ??
  NodeURL.fileURLToPath(new URL("../../../../../.t3/issue-1263/programs/rg.wasm", import.meta.url));
const artifactAvailable = NodeFS.existsSync(artifactPath);
if (!artifactAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_RIPGREP_ARTIFACT === "1") {
  throw new Error(`SIGNALBOX_REQUIRE_RIPGREP_ARTIFACT=1 requires ${artifactPath}`);
}

const module = artifactAvailable ? loadRipgrep() : undefined;

function acknowledgement(value: object): asserts value is {
  host(): KernelSyscallPort;
  stopped(): void;
} {
  if (
    !("stopped" in value) ||
    typeof value.stopped !== "function" ||
    !("host" in value) ||
    typeof value.host !== "function"
  ) {
    throw new Error("Dispatch omitted its syscall host or completion acknowledgement");
  }
}

describe.skipIf(!artifactAvailable)("pinned ripgrep SIGPIPE policy", () => {
  it("returns EPIPE to local ripgrep without terminating it by signal", async () => {
    const fixture = childBusyboxFixture({ env: { PATH: "/bin" } });
    fixture.write("matches", "needle\n".repeat(32));
    const pipe = new KernelPipe(fixture.context.wakes);
    pipe.closeReader();
    const stdout = fixture.filesystem.descriptors.get(1).stdio;
    if (!stdout?.write) throw new Error("Missing stdout");
    const writeStdout = vi.spyOn(stdout, "write").mockImplementation((bytes) => pipe.write(bytes));

    const registry = new KernelProgramRegistry();
    if (registry.register(KERNEL_RIPGREP_PROGRAM_MANIFEST).status !== "ok")
      throw new Error("Could not register ripgrep");
    const host = new KernelProgramHost({
      registry,
      processes: fixture.context.processes,
      wakes: fixture.context.wakes,
      programs: new Map([
        [
          "/bin/rg",
          {
            manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
            implementation: createKernelRipgrepProgram({ module: module! }),
          },
        ],
      ]),
    });
    const prepared = host.prepare({ filesystem: fixture.filesystem });
    try {
      const program = host.resolve("/bin/rg");
      if (program.status !== "ok") throw new Error("Could not resolve ripgrep");
      const spawned = callKernel(host.backend(prepared), "process.spawn", {
        program: program.value,
        args: ["rg", "needle", "matches"],
        env: { PATH: "/bin" },
      });
      if (spawned.status !== "ok") throw new Error("Could not start ripgrep");
      await expect(host.exitStatus(spawned.value)).resolves.toMatchObject({
        status: "ok",
        value: exited(1),
      });
      expect(host.processes.reap(spawned.value).status).toBe("ok");
      expect(writeStdout).toHaveBeenCalled();
      expect(fixture.stderr()).toBe("");
      expect(fixture.context.wakes.size).toBe(0);
    } finally {
      await prepared.release();
      await fixture.close();
      vi.restoreAllMocks();
    }
  });

  it("returns EPIPE to child ripgrep without terminating it by signal", async () => {
    const fixture = childBusyboxFixture({
      args: ["rg", "needle", "matches"],
      env: { PATH: "/bin" },
    });
    fixture.write("matches", "needle\n".repeat(32));
    const pipe = new KernelPipe(fixture.context.wakes);
    pipe.closeReader();
    const stdout = fixture.filesystem.descriptors.get(1).stdio;
    if (!stdout?.write) throw new Error("Missing stdout");
    const writeStdout = vi.spyOn(stdout, "write").mockImplementation((bytes) => pipe.write(bytes));

    const code = { mainModule: "main.js", modules: { "main.js": "export default {};" } };
    const loader: ChildWorkerLoaderPort = {
      async run(input, invocation) {
        acknowledgement(invocation);
        try {
          const wasi = createChildWasi({
            module: module!,
            syscalls: invocation.host(),
            args: input.command.argv,
            env: input.command.env,
          });
          const instance = new WebAssembly.Instance(module!, wasi.imports);
          wasi.bind(instance);
          return await wasi.startProcess(instance);
        } finally {
          invocation.stopped();
        }
      },
    };
    const catalog = createChildProgramCatalog({
      registry: new KernelProgramRegistry(),
      filesystem: fixture.filesystem,
      loader,
      capacity: new ChildWorkerCapacity(),
      programs: { bash: code, busyboxCat: code, ripgrep: code },
      hostname: "ripgrep-sigpipe-test",
    });
    const ripgrep = catalog.bindings.get("/bin/rg")?.implementation;
    if (ripgrep?.kind !== "async") throw new Error("Missing child ripgrep program");

    try {
      expect(await ripgrep.run(fixture.context)).toEqual(exited(1));
      expect(writeStdout).toHaveBeenCalled();
      expect(fixture.stdout()).toEqual(new Uint8Array());
      expect(fixture.stderr()).toBe("");
      expect(fixture.context.processes.size).toBe(1);
      expect(fixture.context.wakes.size).toBe(0);
    } finally {
      await catalog.drain();
      await fixture.close();
      vi.restoreAllMocks();
    }
  });
});

function loadRipgrep() {
  const bytes = new Uint8Array(NodeFS.readFileSync(artifactPath));
  if (
    bytes.byteLength !== KERNEL_RIPGREP_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_RIPGREP_ARTIFACT.sha256
  ) {
    throw new Error("Ripgrep test artifact does not match its pin");
  }
  return new WebAssembly.Module(bytes);
}
