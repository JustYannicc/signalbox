import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramHost } from "./KernelProgramHost.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { AgentOsFileSystemHost } from "./AgentOsFileSystemHost.ts";
import type { KernelDescriptorResource, WasiPollResult } from "./KernelDescriptors.ts";
import type { Storage } from "./storage.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Uses the public kernel entries with static modules inside a Durable Object. */
export async function runKernelRuntimeProof(
  storage: Storage,
  reactor: WebAssembly.Module,
  rg: WebAssembly.Module,
) {
  const checks: { name: string; ok: boolean; detail?: unknown; error?: string }[] = [];
  const run = async (name: string, check: () => unknown | Promise<unknown>) => {
    try {
      checks.push({ name, ok: true, detail: await check() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
  const wakes = new KernelWakeRegistry();
  try {
    await run(
      "public shared-fd reactor suspends, survives memory growth, and reports HUP",
      async () => {
        const { wasi, descriptors } = createKernelAsyncWasi({ filesystem, wakes });
        const resource = new ProofResource();
        const fd = descriptors.register(resource);
        const alias = descriptors.duplicate(fd);
        try {
          assert(
            descriptors.table === filesystem.descriptors,
            "A second descriptor table was created",
          );
          const instance = new WebAssembly.Instance(reactor, wasi.getImportObject());
          const memory = instance.exports.memory;
          const poll = instance.exports.run;
          assert(
            memory instanceof WebAssembly.Memory && typeof poll === "function",
            "Invalid reactor exports",
          );
          const runPoll = poll as (...args: Array<number | bigint>) => unknown;
          await wasi.initialize(instance);
          writeSubscription(memory, fd);
          const pending = wasi.run(runPoll, 0, 64, 1, 96);
          await resource.subscribed;
          assert(wakes.size === 1, "Guest did not suspend through the shared wake registry");
          memory.grow(1);
          resource.setReady({ bytes: 7n });
          assert((await pending) === 0, "Guest poll failed after resume");
          let view = new DataView(memory.buffer);
          assert(
            view.getUint32(96, true) === 1 && view.getBigUint64(80, true) === 7n,
            "Poll wrote stale guest memory",
          );
          resource.setReady({ bytes: 0n, hangup: true });
          writeSubscription(memory, alias);
          assert((await wasi.run(runPoll, 0, 64, 1, 96)) === 0, "Alias HUP poll failed");
          view = new DataView(memory.buffer);
          assert(view.getUint16(88, true) === 1, "HUP was lost");
          await wasi.close();
          assert(filesystem.descriptors.has(fd), "Borrowed lifecycle closed the outer table");
          descriptors.close(fd);
          assert(resource.closed === 0, "Resource closed before its final alias");
          descriptors.close(alias);
          assert(
            Number(resource.closed) === 1 && Number(wakes.size) === 0,
            "Resource or wake leaked",
          );
          return {
            sharedTable: true,
            memoryBytes: memory.buffer.byteLength,
            finalCloseCount: resource.closed,
          };
        } finally {
          await wasi.close();
          for (const descriptor of [fd, alias])
            if (filesystem.descriptors.has(descriptor)) descriptors.close(descriptor);
        }
      },
    );
    await run("real ripgrep module runs through the public program host", () => {
      const registry = new KernelProgramRegistry();
      const manifest = {
        name: "ripgrep",
        version: "0.3.3",
        abiVersion: ABI_VERSION,
        requiredCapabilities: [],
        entrypoint: "rg-pinned",
      } as const;
      assert(registry.register(manifest).status === "ok", "Could not register ripgrep");
      const host = new KernelProgramHost({
        registry,
        wakes,
        programs: new Map([
          ["/bin/rg", { manifest, implementation: { kind: "wasm", module: rg } }],
        ]),
      });
      const resolved = host.resolve("/bin/rg");
      assert(resolved.status === "ok", "Could not resolve pinned ripgrep");
      const output: Uint8Array[] = [];
      const errors: Uint8Array[] = [];
      const prepared = host.prepare(
        { filesystem },
        {
          stdio: [
            { readInto: () => 0 },
            {
              write: (bytes) => {
                output.push(new Uint8Array(bytes));
                return bytes.byteLength;
              },
            },
            {
              write: (bytes) => {
                errors.push(new Uint8Array(bytes));
                return bytes.byteLength;
              },
            },
          ],
        },
      );
      const exitCode = host.runInline(prepared, resolved.value, ["rg", "--version"], {});
      const stdout = output.map((bytes) => new TextDecoder().decode(bytes)).join("");
      const stderr = errors.map((bytes) => new TextDecoder().decode(bytes)).join("");
      assert(exitCode === 0 && stdout.includes("ripgrep"), `ripgrep failed: ${exitCode} ${stderr}`);
      return { exitCode, stdout, stderr };
    });
    await run("real ripgrep searches SQLite-backed bytes with observed host imports", async () => {
      const file = filesystem.open(
        "/rg-proof.txt",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC | KernelOpenFlags.O_RDWR,
      );
      filesystem.write(file, new TextEncoder().encode("first\nneedle\nlast\n"), 0n);
      filesystem.close(file);
      const registry = new KernelProgramRegistry();
      const host = new KernelProgramHost({ registry, wakes });
      const output: Uint8Array[] = [];
      const errors: Uint8Array[] = [];
      const prepared = host.prepare(
        { filesystem },
        {
          stdio: [
            { readInto: () => 0 },
            {
              write: (bytes) => {
                output.push(new Uint8Array(bytes));
                return bytes.byteLength;
              },
            },
            {
              write: (bytes) => {
                errors.push(new Uint8Array(bytes));
                return bytes.byteLength;
              },
            },
          ],
        },
      );
      const { wasi } = createKernelAsyncWasi({
        filesystem: prepared.filesystem,
        wakes,
        options: { version: "preview1", args: ["rg", "-n", "needle", "/rg-proof.txt"] },
      });
      let memory: WebAssembly.Memory | undefined;
      const fileHost = new AgentOsFileSystemHost({
        fileSystem: prepared.filesystem,
        memory: () => {
          if (!memory) throw new Error("Guest memory is not bound");
          return memory;
        },
      });
      const calls: Record<string, number> = {};
      const hostFs: WebAssembly.ModuleImports = {};
      for (const [name, handler] of Object.entries(fileHost.imports)) {
        hostFs[name] = (...args: Array<number | bigint>) => {
          calls[name] = (calls[name] ?? 0) + 1;
          return Reflect.apply(handler, undefined, args);
        };
      }
      try {
        const instance = new WebAssembly.Instance(rg, {
          ...wasi.getImportObject(),
          host_fs: hostFs,
        });
        const exportedMemory = instance.exports.memory;
        assert(exportedMemory instanceof WebAssembly.Memory, "ripgrep did not export memory");
        memory = exportedMemory;
        const exitCode = await wasi.start(instance);
        const stdout = output.map((bytes) => new TextDecoder().decode(bytes)).join("");
        const stderr = errors.map((bytes) => new TextDecoder().decode(bytes)).join("");
        assert(
          exitCode === 0 && stdout === "2:needle\n",
          JSON.stringify({ exitCode, stdout, stderr, calls }),
        );
        return { exitCode, stdout, stderr, calls };
      } finally {
        await wasi.close();
        await prepared.release();
      }
    });
    await run("cwd refreshes same-parent rename and rejects a moved ancestor", () => {
      const prefix = "/cwd-proof";
      for (const path of [prefix, `${prefix}/left`, `${prefix}/right`]) {
        try {
          filesystem.mkdir(path);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
      filesystem.mkdir(`${prefix}/left/start`);
      filesystem.chdir(`${prefix}/left/start`);
      filesystem.rename(`${prefix}/left/start`, `${prefix}/left/renamed`);
      assert(filesystem.cwd === `${prefix}/left/renamed`, "cwd kept its old name");
      filesystem.rename(`${prefix}/left/renamed`, `${prefix}/right/moved`);
      let stale = false;
      try {
        void filesystem.cwd;
      } catch (error) {
        stale = error instanceof Error && "code" in error && error.code === "ESTALE";
      }
      assert(stale, "Moved cwd silently used its old parent");
      filesystem.chdir("/");
      filesystem.rmdir(`${prefix}/right/moved`);
      const fd = filesystem.open(
        `${prefix}/bytes`,
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      filesystem.write(fd, new Uint8Array([3, 7]), 0n);
      filesystem.close(fd);
      return { sameParentRename: "refreshed", movedParent: "ESTALE" };
    });
  } finally {
    filesystem.dispose();
    wakes.dispose();
  }
  return { ok: checks.every((check) => check.ok), checks };
}

class ProofResource implements KernelDescriptorResource {
  #ready: WasiPollResult | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #subscription = Promise.withResolvers<void>();
  readonly subscribed = this.#subscription.promise;
  closed = 0;
  ready() {
    return this.#ready;
  }
  subscribe(_direction: "read" | "write", notify: () => void) {
    this.#listeners.add(notify);
    this.#subscription.resolve();
    return () => {
      this.#listeners.delete(notify);
    };
  }
  setReady(result: WasiPollResult) {
    this.#ready = result;
    for (const notify of Array.from(this.#listeners)) notify();
  }
  close() {
    this.closed++;
    this.#listeners.clear();
  }
}

function writeSubscription(memory: WebAssembly.Memory, fd: number) {
  const view = new DataView(memory.buffer);
  new Uint8Array(memory.buffer, 0, 48).fill(0);
  view.setBigUint64(0, 123n, true);
  view.setUint8(8, 1);
  view.setUint32(16, fd, true);
}
