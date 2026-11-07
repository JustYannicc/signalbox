import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { ThreadId, ProviderSessionId, ProviderInstanceId } from "@t3tools/contracts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import { createClaudeCliFacetClass } from "../../harness/ClaudeCliSession.ts";
import { launchPreparedNodeHarnessProcess } from "../../harness/NodeHarnessLaunch.ts";
import type { NodeHarnessBaseInput } from "../../harness/NodeHarnessProcess.ts";
import type { ClaudeReleasePlan } from "../../harness/HarnessReleasePlan.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { cliFileBackendFixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object, DurableObject: Object }));
vi.mock("../../harness/NodeHarnessLaunch.ts", () => ({
  launchPreparedNodeHarnessProcess: vi.fn(),
}));

const release = {
  harness: "claude-code",
  version: "test",
  manifestSha256: "test",
  modules: {},
} as const;
const plan: ClaudeReleasePlan = {
  release,
  harness: "claude-code",
  sourceIdentity: "test",
  computer: { sourceIdentity: "test", manifestSha256: "test" },
  preparedModules: {},
  assets: [],
  moduleMaps: [],
  workerEntries: {},
  componentManifestPaths: { cli: "cli/manifest.json", sdk: "sdk/manifest.json" },
  main: { module: "cli", export: "launch" },
  initialize: { module: "cli", export: "initialize" },
  embeddedEntrypointExport: "launch",
  embeddedEntrypoints: {},
  hostEntrypoints: {},
  requiredHostModules: { cli: [], sdk: [] },
  environmentPackageModules: {},
  cli: { provider: "claude-code", version: "test", platform: "linux", binarySha256: "test" },
  sdk: {
    provider: "agent-sdk",
    name: "@anthropic-ai/claude-agent-sdk",
    version: "test",
    integrity: "test",
    tarballSha256: "test",
  },
};

async function fixture(options: Parameters<typeof cliFileBackendFixture>[3] = {}) {
  const f = await cliFileBackendFixture(128, ["/sync"], false, options);
  onTestFinished(() => f.close());
  await f.files.close();
  const exited = Promise.withResolvers<{ exitCode: number; signal: number; coreDumped: boolean }>();
  let process: NodeHarnessBaseInput | undefined;
  let disposalFailure: Error | undefined;
  vi.mocked(launchPreparedNodeHarnessProcess).mockImplementation((input) => {
    process = input;
    input.onLaunch?.();
    return {
      stdin: input.stdio.stdin,
      stdout: input.stdio.stdout,
      stderr: input.stdio.stderr,
      exitStatus: undefined,
      exited: exited.promise,
      assertCompatibility: async () => {},
      abort: async () => {},
      async dispose() {
        exited.resolve({ exitCode: 0, signal: 0, coreDumped: false });
        if (disposalFailure !== undefined) throw disposalFailure;
      },
    };
  });
  const Facet = createClaudeCliFacetClass(() => ({
    nativeModules: {},
    loadPackages: async () => ({}),
    loadRelease: async () => ({}),
  }));
  const threadId = ThreadId.make("cli-close-test");
  const cli = await new Facet({} as DurableObjectState, {}).open(
    {
      threadId,
      process: f.processConfiguration,
      systemIdentity: systemIdentityForThread(threadId),
      loaded: { plan },
      source: {
        read: async () => new Uint8Array(),
        releasePayload: async () => new Uint8Array(),
        release: async () => {},
      },
      cwd: "/",
      rootDescriptor: f.rootDescriptor,
      posix: undefined,
      workingSet: { byteLimit: 128, metadataLimit: 128, pathByteLimit: 256 },
      kernel: f.kernel,
      callbacks: {
        model: async () => new Response(),
        cancel: async () => {},
        report: async () => {},
        startup: async () => {},
        observeTool: async () => {},
        continuation: async () => {},
        output: async () => {},
        input: async () => {},
      },
      io: {
        stdin: new ReadableStream(),
        stdout: new WritableStream(),
        stderr: new WritableStream(),
        sdkStdin: new WritableStream(),
        sdkStdout: new ReadableStream(),
        sdkStderr: new ReadableStream(),
      },
    },
    {
      release,
      session: {
        threadId,
        providerSessionId: ProviderSessionId.make("cli-close-test"),
        modelSelection: { instanceId: ProviderInstanceId.make("claude-code"), model: "test" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/" },
      },
    },
  );
  onTestFinished(() => cli.dispose().catch(() => undefined));
  if (process === undefined) throw new Error("CLI process was not created");
  const launched = process;
  return {
    ...f,
    cli,
    fs: createNodeFs(launched.computer.files).fs,
    signal: launched.signal!,
    failDisposal(error: Error) {
      disposalFailure = error;
    },
  };
}

describe("Claude CLI session close", () => {
  it("closes a clean session without reporting its owner abort as a filesystem failure", async () => {
    const f = await fixture();
    await f.fs.promises.readFile("/sync", "utf8");
    await f.fs.promises.readFile("/async", "utf8");
    f.fs.writeFileSync("/sync", "last queued write");
    await expect(f.cli.dispose()).resolves.toBeUndefined();
    expect(f.canonical.readFileSync("/sync", "utf8")).toBe("last queued write");
    expect(f.signal.aborted).toBe(true);
  });

  it("commits writes queued before close and closes descriptors before aborting the owner", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let writing = false;
    let signal: AbortSignal | undefined;
    const closes: boolean[] = [];
    const f = await fixture({
      async syscall(request, invoke) {
        if (writing && request.name === "path_open") {
          entered.resolve();
          await release.promise;
        }
        if (signal !== undefined && request.name === "fd_close") closes.push(signal.aborted);
        return invoke();
      },
    });
    signal = f.signal;
    writing = true;
    f.fs.writeFileSync("/sync", "first queued write");
    f.fs.writeFileSync("/async", "last queued write");
    const closing = f.cli.dispose();
    try {
      await entered.promise;
      expect(f.signal.aborted).toBe(false);
      await expect(f.cli.fs("late-read", "readFile", ["/sync"])).rejects.toThrow(
        "Claude CLI owner closed",
      );
    } finally {
      release.resolve();
      await closing;
    }
    expect(f.canonical.readFileSync("/sync", "utf8")).toBe("first queued write");
    expect(f.canonical.readFileSync("/async", "utf8")).toBe("last queued write");
    expect(closes.length).toBeGreaterThan(0);
    expect(closes.every((aborted) => !aborted)).toBe(true);
    expect(f.signal.aborted).toBe(true);
  });

  it("reports a real Computer flush failure through the original cleanup chain", async () => {
    const f = await fixture();
    f.failWrites();
    f.fs.writeFileSync("/sync", "uncommitted");
    await expect(f.cli.dispose()).rejects.toMatchObject(
      filesystemFailure(expect.objectContaining({ code: "EIO" })),
    );
    expect(f.signal.aborted).toBe(true);
  });

  it("reports a real descriptor close failure", async () => {
    const failure = new Error("Computer descriptor close rejected");
    let closing = false;
    const f = await fixture({
      async syscall(request, invoke) {
        if (closing && request.name === "fd_close") throw failure;
        return invoke();
      },
    });
    closing = true;
    await expect(f.cli.dispose()).rejects.toMatchObject(filesystemFailure(failure));
    expect(f.signal.aborted).toBe(true);
  });

  it("still commits queued writes and aborts the owner when process disposal fails", async () => {
    const f = await fixture();
    const failure = new Error("CLI process disposal rejected");
    f.failDisposal(failure);
    f.fs.writeFileSync("/sync", "committed despite process failure");
    const closing = f.cli.dispose();
    await expect(closing).rejects.toMatchObject({
      message: "Claude CLI cleanup failed",
      errors: [failure],
    });
    expect(f.canonical.readFileSync("/sync", "utf8")).toBe("committed despite process failure");
    expect(f.signal.aborted).toBe(true);
    await expect(f.cli.dispose()).rejects.toBe(await closing.catch((cause: unknown) => cause));
  });
});

function filesystemFailure(failure: unknown) {
  return {
    message: "Claude CLI cleanup failed",
    errors: [
      expect.objectContaining({
        message: "CLI facet cleanup failed",
        errors: [
          expect.objectContaining({
            message: "CLI filesystem cleanup failed",
            errors: expect.arrayContaining([failure]),
          }),
        ],
      }),
    ],
  };
}
