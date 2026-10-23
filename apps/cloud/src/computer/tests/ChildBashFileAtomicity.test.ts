// @effect-diagnostics nodeBuiltinImport:off - reads only the locally prepared, hash-pinned WASM artifact.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { within } from "./ChildBashGatewayCommand.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { readAll } from "../commandGatewayTesting.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";
import { createBashGateway } from "./ChildBashGatewayFixture.ts";
import { bashAtomicityWriters as writers } from "./ChildBashAtomicityCases.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error(`Required GNU Bash test artifact is missing: ${artifact.pathname}`);
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("GNU Bash test artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

const bashArgs = (script: string) => ["bash", "--noprofile", "--norc", "-c", script];

function contiguousRuns(data: string) {
  const result: { readonly byte: number; readonly length: number }[] = [];
  let current = -1;
  let length = 0;
  for (let index = 0; index < data.length; index++) {
    const byte = data.charCodeAt(index);
    if (byte === current) length++;
    else {
      if (current !== -1) result.push({ byte: current, length });
      current = byte;
      length = 1;
    }
  }
  if (current !== -1) result.push({ byte: current, length });
  return result;
}

function hashRuns(first: string, second: string, size: number) {
  const hash = NodeCrypto.createHash("sha256");
  for (const value of [first, second]) {
    const block = new Uint8Array(Math.min(64 * 1024, size)).fill(value.charCodeAt(0));
    for (let offset = 0; offset < size; offset += block.length)
      hash.update(block.subarray(0, Math.min(block.length, size - offset)));
  }
  return hash.digest("hex");
}

async function run(script: string, path: string, residentByteLimit?: number) {
  const run = createBashGateway({ residentByteLimit });
  const { fixture } = run;
  const pressure = Promise.withResolvers<never>();
  const unsubscribe = fixture.capacity.onPressure((value) => {
    if (value.kind === "unplaceable")
      pressure.reject(new Error(`Unplaceable atomicity continuation: ${JSON.stringify(value)}`));
  });
  const child = await fixture.gateway.exec(
    {
      executable: "/bin/bash",
      argv: bashArgs(script),
      cwd: "/workspace",
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    },
    fixture.controller.signal,
    undefined,
  );
  let failure: { readonly error: unknown } | undefined;
  try {
    const outcome = await within(
      Promise.race([
        Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited]),
        pressure.promise,
      ]),
      120_000,
    );
    if (outcome.kind === "deadline")
      throw new Error(`GNU Bash stalled: ${JSON.stringify(run.forkTrace.slice(-40))}`);
    if (outcome.kind === "rejected") throw outcome.error;
    const [stdout, stderr, status] = outcome.value;
    await fixture.gateway.drain();
    let data: string;
    try {
      data = fixture.read(path);
    } catch (cause) {
      throw new Error(
        `Bash output ${path} is missing after ${JSON.stringify(status)}; stderr: ${new TextDecoder().decode(stderr)}`,
        { cause },
      );
    }
    return {
      status,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      byteLength: NodeBuffer.Buffer.byteLength(data, "utf8"),
      sha256: NodeCrypto.createHash("sha256").update(data, "utf8").digest("hex"),
      runs: contiguousRuns(data),
    };
  } catch (error) {
    failure = { error };

    throw error;
  } finally {
    unsubscribe();
    fixture.controller.abort();
    const cleanup: unknown[] = [];
    try {
      await child.dispose();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await fixture.close();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length > 0)
      throw new AggregateError(
        failure === undefined ? cleanup : [failure.error, ...cleanup],
        "Bash file test cleanup failed",
      );
  }
}

const sizes = [
  ["256 KiB", 256 * 1024],
  ["4 MiB", 4 * 1024 * 1024],
  ["16 MiB", 16 * 1024 * 1024],
] as const;

const cases = sizes.flatMap(([sizeLabel, size]) =>
  writers.map((writer) => ({
    size,
    writer,
    label: `${writer.label} preserves two ${sizeLabel} writes`,
  })),
);

describe.skipIf(!available)("pinned GNU Bash file write atomicity", () => {
  it.each(cases)(
    "$label",
    async ({ size, writer }) => {
      // The pinned Bash guest expands a 16 MiB argument into a 128.625 MiB heap.
      // This larger test-only slot proves I/O atomicity; product-budget placement is tested separately.
      const ioAtomicityBudget = size === 16 * 1024 * 1024 ? 160 * 1024 * 1024 : undefined;
      const result = await run(writer.script(size), writer.path, ioAtomicityBudget);
      const firstThenSecond = [
        { byte: "0".charCodeAt(0), length: size },
        { byte: " ".charCodeAt(0), length: size },
      ];
      const secondThenFirst = firstThenSecond.toReversed();
      const expectedHashes = [hashRuns("0", " ", size), hashRuns(" ", "0", size)];

      expect(result.status).toEqual(exited());
      expect(result.stdout).toBe("ok\n");
      expect(result.stderr).toBe("");
      expect(result.byteLength).toBe(2 * size);
      expect([firstThenSecond, secondThenFirst]).toContainEqual(result.runs);
      expect(expectedHashes).toContain(result.sha256);
    },
    150_000,
  );
  it("releases a killed writer's inode lock before the following append", async () => {
    const fixture = childBashFixture({
      args: bashArgs(
        `printf -v X '%0*d' 4194304 0; ( echo -n "$X" >> /workspace/killed.log ) & writer=$!; wait "$writer"; echo -n AFTER >> /workspace/killed.log; echo done`,
      ),
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    });
    const written = Promise.withResolvers<{ pid: number; bytes: number }>();
    const resume = Promise.withResolvers<void>();
    let captured = false;
    const observe = (port: KernelBashPort, pid: number): KernelBashPort => ({
      ...port,
      async call(request) {
        const response = await port.call(request);
        if (
          pid !== fixture.owner.pid &&
          !captured &&
          request.name === "fd_write" &&
          (request.transferLength ?? 0) >= KERNEL_SYSCALL_MAX_IO_BYTES &&
          response.kind === "return" &&
          response.value === 0
        ) {
          captured = true;
          const pointer = Number(request.args[3]);
          const count = response.regions.find(
            (region) =>
              region.pointer <= pointer && region.pointer + region.bytes.byteLength >= pointer + 4,
          );
          if (count === undefined) throw new Error("Writer response has no accepted byte count");
          const bytes = new DataView(
            count.bytes.buffer,
            count.bytes.byteOffset + pointer - count.pointer,
            4,
          ).getUint32(0, true);
          written.resolve({ pid, bytes });
          await resume.promise;
        }
        return response;
      },
      async fork() {
        const child = await port.fork();
        return child.kind === "fork" ? { ...child, port: observe(child.port, child.pid) } : child;
      },
    });
    const running = createChildBash({
      module,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: observe(fixture.owner.port, fixture.owner.pid),
      args: fixture.context.args,
      env: fixture.context.env,
    }).run();
    try {
      const first = await within(written.promise, 15_000);
      expect(first.kind).toBe("completed");
      if (first.kind !== "completed") throw new Error("Writer never accepted its first chunk");
      expect(first.value.bytes).toBe(KERNEL_SYSCALL_MAX_IO_BYTES);
      expect(first.value.bytes).toBeLessThan(4194304);
      expect(
        fixture.processes.signalPid(fixture.context.identity.handle, first.value.pid, 9).status,
      ).toBe("ok");
      resume.resolve();
      const outcome = await within(running, 15_000);
      expect(outcome).toEqual({ kind: "completed", value: exited() });
      expect(fixture.stdout()).toBe("done\n");
      expect(fixture.read("/workspace/killed.log")).toBe(`${"0".repeat(first.value.bytes)}AFTER`);
    } finally {
      resume.resolve();
      fixture.controller.abort();
      await running.catch(() => {});
      await fixture.close();
    }
  }, 45_000);
});
