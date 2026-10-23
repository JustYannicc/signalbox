// @effect-diagnostics nodeBuiltinImport:off - checks locally prepared, pinned WASM programs and optional evidence output.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import type {
  KernelMemoryRegion,
  KernelSyscallRequest,
  KernelSyscallResponse,
} from "../../kernel/KernelSyscallPort.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const output = NodeProcess.env.SIGNALBOX_CHILD_IO_EVIDENCE_DIR;
const programDirectory = new URL("../../../../../.t3/1071/programs/", import.meta.url);
const busyboxPath = new URL("busybox.wasm", programDirectory);
const headPath = new URL("coreutils/head.wasm", programDirectory);
const available = NodeFS.existsSync(busyboxPath) && NodeFS.existsSync(headPath);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_CHILD_IO_ARTIFACTS === "1")
  throw new Error("Child I/O tests require pinned BusyBox and coreutils/head artifacts");
const SIZE = 200 * 1024 * 1024;
let busybox: WebAssembly.Module;
let head: WebAssembly.Module;
if (available) {
  const busyboxBytes = NodeFS.readFileSync(busyboxPath);
  expect(busyboxBytes.byteLength).toBe(KERNEL_BUSYBOX_ARTIFACT.bytes);
  expect(NodeCrypto.createHash("sha256").update(busyboxBytes).digest("hex")).toBe(
    KERNEL_BUSYBOX_ARTIFACT.sha256,
  );
  busybox = new WebAssembly.Module(busyboxBytes);
  const headBytes = NodeFS.readFileSync(headPath);
  const provenance = JSON.parse(
    NodeFS.readFileSync(
      new URL("../../../infra/kernelPrograms/coreutils/provenance.json", import.meta.url),
      "utf8",
    ),
  );
  expect(NodeCrypto.createHash("sha256").update(headBytes).digest("hex")).toBe(
    provenance.commands.head.sha256,
  );
  head = new WebAssembly.Module(headBytes);
}

function counter(label: string) {
  const calls: Record<
    string,
    {
      count: number;
      requested: Record<string, number>;
      moved: Record<string, number>;
      requestRegions: Record<string, number>;
      responseRegions: Record<string, number>;
      bytes: number;
      hostMs: number;
    }
  > = {};
  function bucket(histogram: Record<string, number>, value: number) {
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  return {
    label,
    calls,
    async call<
      T extends
        | KernelSyscallResponse
        | { value: number | bigint; regions: readonly KernelMemoryRegion[] },
    >(request: KernelSyscallRequest, run: () => Promise<T>) {
      const key = `${request.name}${["fd_read", "fd_write", "fd_pread", "fd_pwrite"].includes(request.name) ? `:${request.args[0]}` : ""}`;
      const row = (calls[key] ??= {
        count: 0,
        requested: {},
        moved: {},
        requestRegions: {},
        responseRegions: {},
        bytes: 0,
        hostMs: 0,
      });
      row.count++;
      bucket(
        row.requestRegions,
        request.regions.reduce((sum, region) => sum + region.bytes.byteLength, 0),
      );
      const io = key.startsWith("fd_read:") || key.startsWith("fd_write:");
      if (io) {
        const tablePointer = Number(request.args[1]);
        const count = Number(request.args[2]);
        const table = request.regions.find(
          (r) =>
            r.pointer <= tablePointer && r.pointer + r.bytes.length >= tablePointer + count * 8,
        )!;
        const view = new DataView(
          table.bytes.buffer,
          table.bytes.byteOffset + tablePointer - table.pointer,
          count * 8,
        );
        let requested = 0;
        for (let i = 0; i < count; i++) requested += view.getUint32(i * 8 + 4, true);
        bucket(row.requested, requested);
      }
      const started = performance.now();
      const response = await run();
      row.hostMs += performance.now() - started;
      if ("regions" in response && Array.isArray(response.regions))
        bucket(
          row.responseRegions,
          response.regions.reduce(
            (sum: number, region: { bytes: Uint8Array }) => sum + region.bytes.byteLength,
            0,
          ),
        );
      if (io && "kind" in response && response.kind === "return" && response.value === 0) {
        const result = response as KernelSyscallResponse & { kind: "return" };
        const pointer = Number(request.args[3]);
        const original = request.regions.find(
          (r) => r.pointer <= pointer && r.pointer + r.bytes.length >= pointer + 4,
        )!;
        const word = original.bytes.slice(
          pointer - original.pointer,
          pointer - original.pointer + 4,
        );
        for (const region of result.regions) {
          for (
            let i = Math.max(pointer, region.pointer);
            i < Math.min(pointer + 4, region.pointer + region.bytes.length);
            i++
          )
            word[i - pointer] = region.bytes[i - region.pointer]!;
        }
        const moved = new DataView(word.buffer).getUint32(0, true);
        bucket(row.moved, moved);
        row.bytes += moved;
      }
      return response;
    },
  };
}

function seed(fixture: ReturnType<typeof childBusyboxFixture>) {
  const fd = fixture.filesystem.open("input", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
  const chunk = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
  const hash = NodeCrypto.createHash("sha256");
  try {
    for (let i = 0; i < 200; i++) {
      expect(fixture.filesystem.write(fd, chunk, null)).toBe(chunk.length);
      hash.update(chunk);
    }
  } finally {
    fixture.filesystem.close(fd);
  }
  return hash.digest("hex");
}

function discard(fixture: ReturnType<typeof childBusyboxFixture>) {
  const fd = fixture.filesystem.open("/dev/null", KernelOpenFlags.O_WRONLY);
  const redirected = fixture.filesystem.descriptors.duplicateTo(fd, 1).next();
  expect(redirected).toEqual({ done: true, value: 1 });
  fixture.filesystem.close(fd);
  const stdout = fixture.filesystem.descriptors.get(1).stdio!;
  const write = stdout.write!.bind(stdout);
  let bytes = 0;
  const hash = NodeCrypto.createHash("sha256");
  vi.spyOn(stdout, "write").mockImplementation((chunk, flags) => {
    bytes += chunk.byteLength;
    hash.update(chunk);
    return write(chunk, flags);
  });
  return () => ({ bytes, sha256: hash.digest("hex") });
}

describe.skipIf(!available)("bulk child I/O", () => {
  it.each(["cat-null", "cat-pipe-head", "head-file"] as const)(
    "%s",
    async (scenario) => {
      const producer = childBusyboxFixture({
        args: ["cat", "input"],
        env: { PATH: "/bin", PWD: "/workspace" },
      });
      const expectedSha256 = seed(producer);
      const pipe = new KernelPipe(producer.context.wakes);
      const consumer = childBusyboxFixture({
        args: ["head", "-c", "200M"],
        env: { PATH: "/bin", PWD: "/workspace" },
        readInto: (target) => pipe.readInto(target),
      });
      const catOwner = createKernelBusyboxHost({ context: producer.context });
      const headFixture = scenario === "head-file" ? producer : consumer;
      const headArgs =
        scenario === "head-file" ? ["head", "-c", "200M", "input"] : consumer.context.args;
      const headOwner = createKernelCoreutilsHost({
        context: { ...headFixture.context, args: headArgs },
      });
      const catCounts = counter("cat");
      const headCounts = counter("head");
      const catPort = {
        call: (request: KernelSyscallRequest) =>
          catCounts
            .call(request, () => catOwner.port.call(structuredClone(request)))
            .then((value) => structuredClone(value)),
        callBusybox: (request: Parameters<typeof catOwner.port.callBusybox>[0]) =>
          catCounts
            .call(request, () => catOwner.port.callBusybox(structuredClone(request)))
            .then((value) => structuredClone(value)),
      };
      const headPort = {
        call: (request: KernelSyscallRequest) =>
          headCounts
            .call(request, () => headOwner.port.call(structuredClone(request)))
            .then((value) => structuredClone(value)),
        callCoreutils: (request: Parameters<typeof headOwner.port.callCoreutils>[0]) =>
          headCounts
            .call(request, () => headOwner.port.callCoreutils(structuredClone(request)))
            .then((value) => structuredClone(value)),
      };
      const moved = discard(scenario === "cat-null" ? producer : headFixture);
      if (scenario === "cat-pipe-head") {
        vi.spyOn(producer.filesystem.descriptors.get(1).stdio!, "write").mockImplementation(
          (bytes) => pipe.writeBlocking(bytes),
        );
      }
      const started = performance.now();
      const cpu = NodeProcess.cpuUsage();
      try {
        const results =
          scenario === "head-file"
            ? [
                await createChildCoreutils({
                  module: head,
                  port: headPort,
                  args: headArgs,
                  env: headFixture.context.env,
                }).run(),
              ]
            : await Promise.all([
                createChildBusybox({
                  module: busybox,
                  port: catPort,
                  args: producer.context.args,
                  env: producer.context.env,
                })
                  .run()
                  .finally(() => pipe.closeWriter()),
                ...(scenario === "cat-pipe-head"
                  ? [
                      createChildCoreutils({
                        module: head,
                        port: headPort,
                        args: headArgs,
                        env: consumer.context.env,
                      })
                        .run()
                        .finally(() => pipe.closeReader()),
                    ]
                  : []),
              ]);
        const cpuUsed = NodeProcess.cpuUsage(cpu);
        expect(results).toEqual(results.map(() => exited()));
        const result = moved();
        expect(result.bytes).toBe(SIZE);
        expect(result.sha256).toBe(expectedSha256);
        const counts = [catCounts, headCounts].map(({ label, calls }) => ({ label, calls }));
        const total = counts.reduce(
          (n, c) => n + Object.values(c.calls).reduce((m, row) => m + row.count, 0),
          0,
        );
        const record = {
          scenario,
          size: SIZE,
          sha256: result.sha256,
          wallMs: performance.now() - started,
          cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
          total,
          rpcLatencyEstimateMs: [1, 3, 5].map((ms) => ({ latencyMs: ms, serialMs: total * ms })),
          counts,
        };
        if (output !== undefined)
          NodeFS.writeFileSync(`${output}/${scenario}.json`, JSON.stringify(record, null, 2));
        expect(total, "200 MiB must not require thousands of serial child RPCs").toBeLessThan(
          5_000,
        );
      } finally {
        pipe.closeReader();
        pipe.closeWriter();
        await catOwner.close();
        await headOwner.close();
        await consumer.close();
        await producer.close();
        vi.restoreAllMocks();
      }
    },
    120_000,
  );
});
