// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { coreutilsArtifactsAvailable, coreutilsModule } from "./CoreutilsArtifactFixture.ts";
import { commandGatewayFixture, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { bashCredentials } from "./ChildBashFixture.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function pinned(path: string, pin: { readonly bytes: number; readonly sha256: string }) {
  const bytes = NodeFS.readFileSync(
    new URL(`../../../../../.t3/1071/programs/${path}`, import.meta.url),
  );
  expect(bytes.length).toBe(pin.bytes);
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(pin.sha256);
  return new WebAssembly.Module(bytes);
}

const available = ["bash.wasm", "busybox.wasm"].every((name) =>
  NodeFS.existsSync(new URL(`../../../../../.t3/1071/programs/${name}`, import.meta.url)),
);
if (
  !available &&
  [
    NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT,
    NodeProcess.env.SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT,
  ].includes("1")
)
  throw new Error("Bash fork placement requires pinned Bash and BusyBox artifacts");
const bash = available ? pinned("bash.wasm", KERNEL_BASH_ARTIFACT) : undefined;
const busybox = available ? pinned("busybox.wasm", KERNEL_BUSYBOX_ARTIFACT) : undefined;
const budget = 64 * 1024 * 1024;

describe.skipIf(!available || !coreutilsArtifactsAvailable)("GNU Bash fork placement", () => {
  it.each([15, 40])("bounds resident WASM for %i concurrent pipeline jobs", async (jobs) => {
    const reactors: ReturnType<typeof createChildBash>[] = [];
    const invalidReads: Promise<unknown>[] = [];
    let snapshotChunks = 0;
    let peakChunkBytes = 0;
    const fixture = commandGatewayFixture({
      async run(input, invocation) {
        try {
          if (input.command.executable === "/bin/bash") {
            const port = await invocation.host<
              KernelBashPort & {
                metadata(): Promise<{ pid: number }>;
                forkSnapshot(): KernelBashForkSource | undefined;
              }
            >();
            const { pid } = await port.metadata();
            const reactor = createChildBash({
              module: bash!,
              credentials: bashCredentials,
              pid,
              port,
              args: input.command.argv,
              env: input.command.env,
              snapshot: await port.forkSnapshot(),
              createForkSource(source) {
                invalidReads.push(
                  expect(source.read(0, 65_537)).rejects.toThrow(
                    "Invalid Bash fork snapshot chunk",
                  ),
                  expect(source.read(-1, 1)).rejects.toThrow("Invalid Bash fork snapshot chunk"),
                );
                return {
                  async state() {
                    return structuredClone(await source.state());
                  },
                  async read(offset, length) {
                    const bytes = await source.read(offset, length);
                    snapshotChunks++;
                    peakChunkBytes = Math.max(peakChunkBytes, bytes.byteLength);
                    return structuredClone(bytes);
                  },
                  restored: () => source.restored(),
                };
              },
            });
            reactors.push(reactor);
            try {
              return await reactor.run();
            } finally {
              await reactor.drain();
            }
          }
          const options = { args: input.command.argv, env: input.command.env };
          if (input.command.executable === "/bin/head") {
            return await createChildCoreutils({
              ...options,
              module: coreutilsModule("head"),
              port: await invocation.host<KernelCoreutilsPort>(),
            }).run();
          }
          if (input.command.executable === "/bin/cat") {
            return await createChildBusybox({
              ...options,
              module: busybox!,
              port: await invocation.host<KernelBusyboxPort>(),
            }).run();
          }
          throw new Error(`Unexpected executable: ${input.command.executable}`);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    fixture.filesystem.mkdir("/workspace/gate");
    fixture.filesystem.mkdir("/bin");
    for (const name of ["bash", "head", "cat"]) fixture.write(`/bin/${name}`, "", 0o755);
    const payload = "A".repeat(1024 * 1024);
    fixture.write("/workspace/big.bin", payload);
    const command = `for i in {1..${jobs}}; do (head -c 1048576 big.bin | cat > "gate/job-$i.bin"; s=$?; printf "%s\\n" "$s" > "gate/job-$i.exit") & done; wait; for i in {1..${jobs}}; do printf "%s " "$i"; cat "gate/job-$i.exit"; done`;
    let child;
    try {
      child = await fixture.gateway.exec(
        {
          executable: "/bin/bash",
          argv: ["bash", "--noprofile", "--norc", "-c", command],
          cwd: "/workspace",
          env: { HOME: "/workspace", PATH: "/bin" },
        },
        fixture.controller.signal,
        undefined,
      );
      const [stdout, stderr, result] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      await child.dispose();
      child = undefined;
      expect(new TextDecoder().decode(stderr)).toBe("");
      expect(result).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(new TextDecoder().decode(stdout)).toBe(
        Array.from({ length: jobs }, (_, index) => `${index + 1} 0\n`).join(""),
      );
      for (let index = 1; index <= jobs; index++) {
        expect(fixture.read(`/workspace/gate/job-${index}.exit`)).toBe("0\n");
        expect(fixture.read(`/workspace/gate/job-${index}.bin`)).toBe(payload);
      }
      expect(
        Math.max(...reactors.map((reactor) => reactor.peakResidentWasmBytes)),
      ).toBeLessThanOrEqual(budget);
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
      await Promise.all(invalidReads);
      expect(snapshotChunks).toBeGreaterThan(0);
      expect(peakChunkBytes).toBeLessThanOrEqual(65_536);
    } finally {
      await child?.dispose();
      await fixture.close();
    }
  });
});
