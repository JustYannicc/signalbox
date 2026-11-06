import { describe, expect, it, vi } from "vite-plus/test";
import { createRemoteChildren } from "../../harness/ClaudeCliChildren.ts";
import type { ClaudeCliKernelPort } from "../../harness/ClaudeCliKernelPort.ts";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

interface Child {
  on(event: string, listener: (...args: never[]) => void): unknown;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  readonly stdin: { end(input?: string): void };
}

/** Runs one child through the CLI's real bracket; Computer's side is a scripted process. */
async function runChild(
  files: Awaited<ReturnType<typeof fixture>>["files"],
  stdout: ReadableStream<Uint8Array | ArrayBuffer>,
  stdin: WritableStream<Uint8Array> = new WritableStream(),
) {
  const exited = Promise.withResolvers<{ exitCode: number; signal: number; coreDumped: boolean }>();
  const brackets = { opened: 0, closed: 0 };
  const kernel = {
    leaseProcesses: async (count: number) =>
      Array.from({ length: count }, (_, index) => ({ pid: 100 + index, handle: {} })),
    cancel: async () => {},
    spawn: async () => ({
      pid: 100,
      handle: {},
      stdin,
      stdout,
      stderr: new ReadableStream({
        start: (controller) => void exited.promise.then(() => controller.close()),
      }),
      control: { exited: () => exited.promise, signal: async () => true, dispose: async () => {} },
    }),
  } as unknown as ClaudeCliKernelPort;
  const children = await createRemoteChildren({
    kernel,
    process: { env: {}, computer: { files: { cwd: "/" } } } as never,
    beforeRemote: async () => {
      brackets.opened++;
      await files.beforeRemote();
    },
    afterRemote: async () => {
      brackets.closed++;
      await files.afterRemote();
    },
  });
  const child = children(new AbortController().signal, () => {}).spawn("/bin/sh", ["-c", "true"], {
    stdio: "pipe",
  }) as unknown as Child;
  const errors: unknown[] = [];
  const output: Buffer[] = [];
  child.on("error", (cause: unknown) => errors.push(cause));
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  const closed = new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => child.on("spawn", resolve));
  child.stdin.end('{"hook_event_name":"SessionStart"}\n');
  exited.resolve({ exitCode: 0, signal: 0, coreDumped: false });
  await closed;
  return { brackets, errors, output: Buffer.concat(output).toString("utf8") };
}

describe("CLI child filesystem bracket", () => {
  it("passes ArrayBuffer output through and reopens the view when the child closes", async () => {
    const f = await fixture();
    try {
      const run = await runChild(
        f.files,
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}\n").buffer);
            controller.close();
          },
        }),
      );
      expect(run.output).toBe("{}\n");
      expect(run.errors).toEqual([]);
      expect(run.brackets).toEqual({ opened: 1, closed: 1 });
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });

  it("reopens the view when a child's output fails", async () => {
    const f = await fixture();
    try {
      const run = await runChild(
        f.files,
        new ReadableStream({
          start(controller) {
            controller.error(new Error("output transport failed"));
          },
        }),
      );
      expect(run.errors).toHaveLength(1);
      expect(run.brackets).toEqual({ opened: 1, closed: 1 });
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });

  it("reopens the view when Computer rejects a child's stdin", async () => {
    const f = await fixture();
    try {
      const run = await runChild(
        f.files,
        new ReadableStream({ start: (controller) => controller.close() }),
        new WritableStream({
          write() {
            throw new TypeError("stdin bridge rejected the chunk");
          },
        }),
      );
      expect(run.errors).toHaveLength(1);
      expect(run.brackets).toEqual({ opened: 1, closed: 1 });
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
    } finally {
      await f.close();
    }
  });
});
