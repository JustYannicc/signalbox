import { describe, expect, it, vi } from "vite-plus/test";
import { createRemoteChildren } from "../../harness/ClaudeCliChildren.ts";
import type { ClaudeCliKernelPort } from "../../harness/ClaudeCliKernelPort.ts";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Exit = { exitCode: number; signal: number; coreDumped: boolean };

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Computer's side of a child, scripted. Like the real owner, it needs each descriptor the child
 * inherits to be open when the spawn arrives, and fails the spawn with EBADF otherwise.
 */
function scripted(
  f: Fixture,
  behaviour: { readonly spawn?: () => void; readonly exited?: () => Promise<Exit> } = {},
) {
  const exited = Promise.withResolvers<Exit>();
  const ended = (stream: ReadableStreamDefaultController<Uint8Array>) =>
    void exited.promise.then(
      () => stream.close(),
      () => stream.close(),
    );
  const kernel = new Proxy(f.kernel, {
    get(target, property) {
      if (property === "leaseProcesses")
        return async (count: number) =>
          Array.from({ length: count }, (_, index) => ({ pid: 100 + index, handle: {} }));
      if (property === "cancel") return async () => {};
      if (property === "spawn")
        return async (
          _id: string,
          _lease: unknown,
          input: { readonly stdio: readonly unknown[] },
        ) => {
          for (const mode of input.stdio) if (typeof mode === "number") f.canonical.fstatSync(mode);
          behaviour.spawn?.();
          return {
            pid: 100,
            handle: {},
            stdin: new WritableStream(),
            stdout: new ReadableStream({ start: ended }),
            stderr: new ReadableStream({ start: ended }),
            control: {
              exited: behaviour.exited ?? (() => exited.promise),
              signal: async () => true,
              dispose: async () => {},
            },
          };
        };
      return Reflect.get(target, property);
    },
  }) as unknown as ClaudeCliKernelPort;
  return { kernel, exited };
}

async function children(f: Fixture, kernel: ClaudeCliKernelPort, slowSpawn = false) {
  return (
    await createRemoteChildren({
      kernel,
      process: { env: {}, computer: { files: { cwd: "/" } } } as never,
      // A spawn can take longer than a close to reach Computer, as when the view catches up first.
      beforeRemote: async () => {
        if (slowSpawn) for (let round = 0; round < 3; round++) await f.files.barrier();
        await f.files.beforeRemote();
      },
      afterRemote: f.files.afterRemote,
      holdDescriptors: f.files.holdDescriptors,
    })
  )(new AbortController().signal, () => {});
}

function watch(child: NodeJS.EventEmitter & { readonly stderr?: NodeJS.ReadableStream | null }) {
  const errors: unknown[] = [];
  let stderr = "";
  child.on("error", (cause: unknown) => errors.push(cause));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<readonly [number | null, string | null]>((resolve) =>
    child.on("close", (code: number | null, signal: string | null) => resolve([code, signal])),
  );
  return { errors, closed, stderr: () => stderr };
}

describe("CLI children and their descriptors", () => {
  it("keeps a child's output file open until Computer has it, though the CLI closes its copy at once", async () => {
    const f = await fixture();
    try {
      const { kernel, exited } = scripted(f);
      const spawn = await children(f, kernel, true);
      // Claude Code's Bash tool: open the task output file, give it to the child as stdout and
      // stderr, and close its own copy right after spawn().
      const output = await f.fs.promises.open("/output", "w");
      const child = spawn.spawn("/bin/bash", ["-c", "true"], {
        stdio: ["pipe", output.fd, output.fd],
      });
      const watched = watch(child);
      await output.close();
      exited.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await watched.closed).toEqual([0, null]);
      expect(watched.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("exits 126 with the error on stderr when Computer can't start the child", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f, {
        spawn: () => {
          throw failure("EBADF", "bad file descriptor");
        },
      });
      const child = (await children(f, kernel)).spawn("/bin/bash", ["-c", "true"]);
      const watched = watch(child);
      expect(await watched.closed).toEqual([126, null]);
      expect(watched.errors).toEqual([]);
      expect(watched.stderr()).toContain("Bad file descriptor");
    } finally {
      await f.close();
    }
  });

  it("exits 1 with the error on stderr when a started child fails in Computer", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f, {
        exited: () => Promise.reject(failure("EBADF", "bad file descriptor")),
      });
      const child = (await children(f, kernel)).spawn("/bin/bash", ["-c", "true"]);
      const watched = watch(child);
      expect(await watched.closed).toEqual([1, null]);
      expect(watched.errors).toEqual([]);
      expect(watched.stderr()).toContain("Bad file descriptor");
    } finally {
      await f.close();
    }
  });

  it("keeps Node's spawn error for a program that doesn't exist, with its negative errno", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f, {
        spawn: () => {
          throw failure("ENOENT", "no such file or directory");
        },
      });
      const child = (await children(f, kernel)).spawn("/bin/missing", []);
      const watched = watch(child);
      expect(await watched.closed).toEqual([-2, null]);
      expect(watched.errors).toEqual([expect.objectContaining({ code: "ENOENT" })]);
    } finally {
      await f.close();
    }
  });
});
