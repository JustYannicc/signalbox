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
 * inherits to be open when the spawn arrives, and fails the spawn with EBADF otherwise. A cancel
 * refuses the spawn, before or while it runs, with a plain error, as one arrives over RPC.
 */
function scripted(
  f: Fixture,
  behaviour: {
    readonly spawn?: () => void | Promise<void>;
    readonly exited?: () => Promise<Exit>;
  } = {},
) {
  const exited = Promise.withResolvers<Exit>();
  const cancelled = new Set<string>();
  const running = new Map<string, () => void>();
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
      if (property === "cancel")
        return async (id: string) => {
          const cancel = running.get(id);
          if (cancel === undefined) cancelled.add(id);
          else cancel();
        };
      if (property === "spawn")
        return async (
          id: string,
          _lease: unknown,
          input: { readonly stdio: readonly unknown[] },
        ) => {
          if (cancelled.has(id)) throw new Error("operation cancelled");
          const refused = Promise.withResolvers<never>();
          running.set(id, () => refused.reject(new Error("operation cancelled")));
          try {
            for (const mode of input.stdio)
              if (typeof mode === "number") f.canonical.fstatSync(mode);
            await Promise.race([behaviour.spawn?.(), refused.promise]);
          } finally {
            running.delete(id);
          }
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

async function children(
  f: Fixture,
  kernel: ClaudeCliKernelPort,
  options: {
    /** A spawn can take longer than a close to reach Computer, as when the view catches up first. */
    readonly slowSpawn?: boolean;
    readonly beforeRemote?: () => Promise<void>;
    readonly stop?: AbortSignal;
  } = {},
) {
  return (
    await createRemoteChildren({
      kernel,
      process: { env: {}, computer: { files: { cwd: "/" } } } as never,
      beforeRemote:
        options.beforeRemote ??
        (async () => {
          if (options.slowSpawn) for (let round = 0; round < 3; round++) await f.files.barrier();
          await f.files.beforeRemote();
        }),
      afterRemote: f.files.afterRemote,
      holdDescriptors: f.files.holdDescriptors,
      writeDescriptor: f.files.writeDescriptor,
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    })
  )(new AbortController().signal, () => {});
}

/** Opens descriptors the CLI reads synchronously until it has no slot left. */
function exhaust(f: Fixture) {
  const opened: number[] = [];
  for (let attempt = 0; attempt < 128; attempt++)
    try {
      opened.push(f.fs.openSync("/sync", "r"));
    } catch (cause) {
      expect(cause).toEqual(expect.objectContaining({ code: "EMFILE" }));
      return opened;
    }
  throw new Error("descriptor slots never ran out");
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
      const spawn = await children(f, kernel, { slowSpawn: true });
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

  // A started child is past Node's spawn errors, whatever code Computer's failure carries.
  it.each([
    ["EBADF", "bad file descriptor", "Bad file descriptor"],
    ["ENOENT", "no such file or directory", "no such file or directory"],
  ])(
    "exits 1 with the error on stderr when a started child fails in Computer with %s",
    async (code, message, shown) => {
      const f = await fixture();
      try {
        const { kernel } = scripted(f, { exited: () => Promise.reject(failure(code, message)) });
        const child = (await children(f, kernel)).spawn("/bin/bash", ["-c", "true"]);
        const watched = watch(child);
        expect(await watched.closed).toEqual([1, null]);
        expect(watched.errors).toEqual([]);
        expect(watched.stderr().toLowerCase()).toContain(shown.toLowerCase());
      } finally {
        await f.close();
      }
    },
  );

  it("writes the error to the Bash tool's output file when Computer can't start the child", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f, {
        spawn: () => {
          throw failure("EBADF", "bad file descriptor");
        },
      });
      const spawn = await children(f, kernel);
      // The Bash tool's shape: the output file is the child's stdout and stderr, so there is no
      // stderr pipe, and the CLI closes its copy right after spawn().
      const output = await f.fs.promises.open("/output", "w");
      const child = spawn.spawn("/bin/bash", ["-c", "true"], {
        stdio: ["pipe", output.fd, output.fd],
      });
      const watched = watch(child);
      await output.close();
      expect(await watched.closed).toEqual([126, null]);
      expect(watched.errors).toEqual([]);
      expect(f.canonical.readFileSync("/output", "utf8")).toContain("Bad file descriptor");
    } finally {
      await f.close();
    }
  });

  it("exits 126 when an earlier write fails before the child reaches Computer, whatever its code", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f);
      const spawn = await children(f, kernel, {
        // The view's write queue rejects the barrier with that write's own error.
        beforeRemote: () => Promise.reject(failure("ENOENT", "no such file or directory")),
      });
      const child = spawn.spawn("/bin/bash", ["-c", "true"]);
      const watched = watch(child);
      expect(await watched.closed).toEqual([126, null]);
      expect(watched.errors).toEqual([]);
      expect(watched.stderr().toLowerCase()).toContain("no such file or directory");
    } finally {
      await f.close();
    }
  });

  it("ends a child killed before it reaches Computer by its signal, whatever error the refusal carries", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f);
      const child = (await children(f, kernel, { slowSpawn: true })).spawn("/bin/bash", [
        "-c",
        "true",
      ]);
      const watched = watch(child);
      child.kill();
      expect(await watched.closed).toEqual([null, "SIGTERM"]);
      expect(watched.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("keeps a running child's descriptor out of reuse after the CLI closes it, until the child exits", async () => {
    const f = await fixture();
    try {
      const { kernel, exited } = scripted(f);
      const spawn = await children(f, kernel);
      const inherited = f.fs.openSync("/sync", "r");
      const child = spawn.spawn("/bin/bash", ["-c", "true"], {
        stdio: ["pipe", inherited, inherited],
      });
      const watched = watch(child);
      f.fs.closeSync(inherited);
      await new Promise((resolve) => child.once("spawn", resolve));
      await f.files.barrier();
      // Computer still has the child's copy, so the CLI must not get that number back yet.
      const whileRunning = exhaust(f);
      expect(whileRunning).not.toContain(inherited);
      for (const fd of whileRunning) f.fs.closeSync(fd);
      exited.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await watched.closed).toEqual([0, null]);
      await f.files.barrier();
      const afterExit = exhaust(f);
      expect(afterExit).toContain(inherited);
      for (const fd of afterExit) f.fs.closeSync(fd);
    } finally {
      await f.close();
    }
  });

  it("closes the CLI's copy without waiting for a child stuck reaching Computer, which stopping ends", async () => {
    const f = await fixture();
    try {
      const { kernel } = scripted(f, { spawn: () => new Promise<void>(() => {}) });
      const stop = new AbortController();
      const spawn = await children(f, kernel, { stop: stop.signal });
      const output = await f.fs.promises.open("/output", "w");
      const child = spawn.spawn("/bin/bash", ["-c", "true"], {
        stdio: ["pipe", output.fd, output.fd],
      });
      const watched = watch(child);
      await output.close();
      // The CLI facet closing stops its children before its files.
      stop.abort(new Error("CLI facet closed"));
      expect(await watched.closed).toEqual([null, "SIGTERM"]);
      expect(watched.errors).toEqual([expect.objectContaining({ name: "AbortError" })]);
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
