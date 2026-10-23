// @effect-diagnostics nodeBuiltinImport:off - checks locally prepared, pinned WASM programs.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { kernelPayloadBudget } from "../../kernel/KernelPayloadBudget.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import { bashArtifactAvailable, startBlockedBashReaders } from "./ChildBlockedReadersFixture.ts";
import { coreutilsArtifactsAvailable, coreutilsModule } from "./CoreutilsArtifactFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const busyboxPath = new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url);
const available = NodeFS.existsSync(busyboxPath) && coreutilsArtifactsAvailable;
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_CHILD_IO_ARTIFACTS === "1")
  throw new Error("Child I/O tests require pinned BusyBox and coreutils artifacts");
const SIZE = 200 * 1024 * 1024;
const BLOCKED_BASH_READERS = 16;
const scenarios = ["cat-null", "cat-pipe-head", "head-file"] as const;
type Scenario = (typeof scenarios)[number];

function loadBusybox(): WebAssembly.Module {
  const bytes = NodeFS.readFileSync(busyboxPath);
  if (
    bytes.byteLength !== KERNEL_BUSYBOX_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BUSYBOX_ARTIFACT.sha256
  )
    throw new Error("BusyBox test artifact does not match its pin");
  return new WebAssembly.Module(bytes);
}

/** Counts every child-to-owner call, the round trips a deployed child pays for. */
function counted<Port extends Record<string, (request: never) => Promise<unknown>>>(
  port: Port,
  calls: { count: number },
): Port {
  return Object.fromEntries(
    Object.entries(port).map(([name, method]) => [
      name,
      async (request: never) => {
        calls.count++;
        return structuredClone(await method(structuredClone(request)));
      },
    ]),
  ) as Port;
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

function trackOpenCredits() {
  let outstanding = 0;
  const open = kernelPayloadBudget.open.bind(kernelPayloadBudget);
  const spy = vi.spyOn(kernelPayloadBudget, "open").mockImplementation(async (...args) => {
    const window = await open(...args);
    outstanding++;
    let released = false;
    return {
      ...window,
      release() {
        if (released) return;
        released = true;
        outstanding--;
        window.release();
      },
    };
  });
  return {
    outstanding: () => outstanding,
    restore: () => spy.mockRestore(),
  };
}

async function runScenario(scenario: Scenario, blockedReaderCount: number) {
  const credits = blockedReaderCount > 0 ? trackOpenCredits() : undefined;
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
  const calls = { count: 0 };
  const catPort = counted(
    {
      call: catOwner.port.call.bind(catOwner.port),
      callBusybox: catOwner.port.callBusybox.bind(catOwner.port),
    },
    calls,
  );
  const headPort = counted(
    {
      call: headOwner.port.call.bind(headOwner.port),
      callCoreutils: headOwner.port.callCoreutils.bind(headOwner.port),
    },
    calls,
  );
  const moved = discard(scenario === "cat-null" ? producer : headFixture);
  if (scenario === "cat-pipe-head") {
    vi.spyOn(producer.filesystem.descriptors.get(1).stdio!, "write").mockImplementation((bytes) =>
      pipe.writeBlocking(bytes),
    );
  }
  let blockedReaders: Awaited<ReturnType<typeof startBlockedBashReaders>> | undefined;
  try {
    if (blockedReaderCount > 0) {
      blockedReaders = await startBlockedBashReaders(blockedReaderCount);
      expect(blockedReaders.fdReadEntries()).toBe(blockedReaderCount + 1);
      expect(blockedReaders.forkCount()).toBe(blockedReaderCount + 1);
    }
    const results =
      scenario === "head-file"
        ? [
            await createChildCoreutils({
              module: coreutilsModule("head"),
              port: headPort,
              args: headArgs,
              env: headFixture.context.env,
            }).run(),
          ]
        : await Promise.all([
            createChildBusybox({
              module: loadBusybox(),
              port: catPort,
              args: producer.context.args,
              env: producer.context.env,
            })
              .run()
              .finally(() => pipe.closeWriter()),
            ...(scenario === "cat-pipe-head"
              ? [
                  createChildCoreutils({
                    module: coreutilsModule("head"),
                    port: headPort,
                    args: headArgs,
                    env: consumer.context.env,
                  })
                    .run()
                    .finally(() => pipe.closeReader()),
                ]
              : []),
          ]);
    expect(results).toEqual(results.map(() => exited()));
    const result = moved();
    expect(result.bytes).toBe(SIZE);
    expect(result.sha256).toBe(expectedSha256);
    expect(
      calls.count,
      `200 MiB with ${blockedReaderCount} blocked Bash readers must stay below 5,000 RPCs`,
    ).toBeLessThan(5_000);
  } finally {
    if (blockedReaders !== undefined) await blockedReaders.close();
    pipe.closeReader();
    pipe.closeWriter();
    await catOwner.close();
    await headOwner.close();
    await consumer.close();
    await producer.close();
    const outstanding = credits?.outstanding();
    credits?.restore();
    vi.restoreAllMocks();
    if (outstanding !== undefined) expect(outstanding).toBe(0);
  }
}

describe.skipIf(!available)("bulk child I/O", () => {
  it.each(scenarios)(
    "%s with 0 blocked Bash readers",
    async (scenario) => {
      await runScenario(scenario, 0);
    },
    120_000,
  );
});

describe.skipIf(!available || !bashArtifactAvailable)(
  "bulk child I/O with 16 blocked Bash readers",
  () => {
    it.each(scenarios)(
      "%s with 16 blocked Bash readers",
      async (scenario) => {
        await runScenario(scenario, BLOCKED_BASH_READERS);
      },
      120_000,
    );
  },
);

describe.skipIf(!available)("small-file child I/O", () => {
  it("cats 1,000 small files without an empty internal EOF RPC", async () => {
    const names = Array.from({ length: 1000 }, (_, index) => `small-${index}`);
    const fixture = childBusyboxFixture({
      args: ["cat", ...names],
      env: { PATH: "/bin", PWD: "/workspace" },
    });
    const hash = NodeCrypto.createHash("sha256");
    for (const name of names) {
      const fd = fixture.filesystem.open(name, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      const bytes = new Uint8Array(100).fill(name.length);
      expect(fixture.filesystem.write(fd, bytes, null)).toBe(100);
      fixture.filesystem.close(fd);
      hash.update(bytes);
    }
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const calls = { count: 0 };
    let reads = 0;
    const port = counted(
      {
        call: async (request: KernelSyscallRequest) => {
          if (request.name === "fd_read") reads++;
          return owner.port.call(request);
        },
        callBusybox: owner.port.callBusybox.bind(owner.port),
      },
      calls,
    );
    const moved = discard(fixture);
    try {
      expect(
        await createChildBusybox({
          module: loadBusybox(),
          port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run(),
      ).toEqual(exited());
      expect(moved()).toEqual({ bytes: 100000, sha256: hash.digest("hex") });
      expect(reads).toBe(2000);
      expect(calls.count).toBeLessThanOrEqual(6013);
    } finally {
      await owner.close();
      await fixture.close();
      vi.restoreAllMocks();
    }
  });
});
