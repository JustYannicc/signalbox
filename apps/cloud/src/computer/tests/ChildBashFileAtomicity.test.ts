// @effect-diagnostics nodeBuiltinImport:off - reads only the locally prepared, hash-pinned WASM artifact.
// @effect-diagnostics globalTimers:off - a deadline bounds a stalled guest without polling.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

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

type Completion<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "deadline" };

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<Completion<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), milliseconds);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

async function run(script: string, path: string) {
  const fixture = childBashFixture({
    args: bashArgs(script),
    env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
  });
  try {
    const outcome = await within(
      createChildBash({
        module,
        credentials: bashCredentials,
        pid: fixture.owner.pid,
        port: fixture.owner.port,
        args: fixture.context.args,
        env: fixture.context.env,
      }).run(),
      120_000,
    );
    if (outcome.kind === "deadline") throw new Error("GNU Bash did not finish within 120 seconds");
    if (outcome.kind === "rejected") throw outcome.error;
    const data = fixture.read(path);
    return {
      status: outcome.value,
      stdout: fixture.stdout(),
      stderr: fixture.stderr(),
      byteLength: NodeBuffer.Buffer.byteLength(data, "utf8"),
      sha256: NodeCrypto.createHash("sha256").update(data, "utf8").digest("hex"),
      runs: contiguousRuns(data),
    };
  } finally {
    fixture.controller.abort();
    await fixture.close();
  }
}

const barrier = (size: number, body: (payload: string) => string) =>
  `printf -v A '%0*d' ${size} 0; printf -v B '%*s' ${size} ''; coproc FEED { while read -r l; do echo "$l"; done; }; exec 5<&\${FEED[0]} 6>&\${FEED[1]}; ` +
  `( read -r _ <&5; ${body("$A")} ) & ( read -r _ <&5; ${body("$B")} ) & echo go >&6; echo go >&6; exec 6>&- 5<&-; eval "exec \${FEED[1]}>&-"; wait; echo ok`;

const sizes = [
  ["256 KiB", 256 * 1024],
  ["4 MiB", 4 * 1024 * 1024],
  ["16 MiB", 16 * 1024 * 1024],
] as const;
const writers = [
  {
    label: "O_APPEND",
    path: "/workspace/append.log",
    script: (size: number) =>
      barrier(size, (payload) => `echo -n "${payload}" >> /workspace/append.log`),
  },
  {
    label: "shared open offset",
    path: "/workspace/shared-offset.log",
    script: (size: number) =>
      `exec 7>/workspace/shared-offset.log; ${barrier(size, (payload) => `echo -n "${payload}" >&7`)}`,
  },
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
      const result = await run(writer.script(size), writer.path);
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
