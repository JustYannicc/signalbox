import { describe, expect, it } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelCommandExecutor } from "./KernelCommandExecutor.ts";
import { canonicalFileByteSelection, type KernelFileByteView } from "./KernelFileBytes.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

describe("trusted command file selection", () => {
  it("lets one command binding retain canonical bytes while the same host defaults to a view", async () => {
    const database = sqliteFixture();
    const storage = createFacetSqliteStorage(database.storage, () => 1n);
    const canonical = new TextEncoder().encode("canonical placeholder");
    const selected = new TextEncoder().encode("selected execution bytes");
    const inode = storage.create(storage.root, "file", { type: "file", exclusive: true });
    storage.write(inode, 0n, canonical);
    storage.release(inode);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    const wakes = new KernelWakeRegistry();
    const registry = new KernelProgramRegistry();
    const view: KernelFileByteView = {
      completion: "sync",
      storage,
      bind(bound) {
        return {
          stat: () => ({ ...storage.stat(bound), size: BigInt(selected.byteLength) }),
          readInto(offset, target) {
            const bytes = selected.subarray(Number(offset), Number(offset) + target.byteLength);
            target.set(bytes);
            return bytes.byteLength;
          },
          write: (offset, bytes) => storage.write(bound, offset, bytes),
          append: (bytes) => storage.append(bound, bytes),
          truncate: (size) => storage.truncate(bound, size),
          sync: (dataOnly) => storage.sync(bound, dataOnly),
          release() {},
        };
      },
    };
    const binding: KernelProgramBinding = {
      manifest: {
        name: "file-reader",
        version: "1",
        abiVersion: ABI_VERSION,
        requiredCapabilities: [],
        entrypoint: "file-reader",
      },
      implementation: {
        kind: "javascript",
        runInline({ filesystem }) {
          const fd = filesystem.open("/file", KernelOpenFlags.O_RDONLY);
          try {
            const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
            const count = filesystem.read(fd, bytes, null);
            filesystem.write(1, bytes.subarray(0, count), null);
            return 0;
          } finally {
            filesystem.close(fd);
          }
        },
      },
    };
    expect(registry.register(binding.manifest).status).toBe("ok");
    const host = new KernelProgramHost({
      registry,
      wakes,
      programs: new Map([["/bin/read", binding]]),
      selectFileBytes: () => ({ kind: "view", view }),
    });
    const shared = {
      host,
      filesystem,
      forwarder: {
        async spawn(): Promise<never> {
          throw new Error("Unexpected machine fallback");
        },
      },
    };
    try {
      for (const [executor, expected] of [
        [
          new KernelCommandExecutor({ ...shared, fileBytes: canonicalFileByteSelection }),
          canonical,
        ],
        [new KernelCommandExecutor(shared), selected],
      ] as const) {
        const child = await executor.spawn(
          { executable: "/bin/read", argv: ["read"], cwd: "/", env: {} },
          new AbortController().signal,
        );
        try {
          const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).bytes(),
            new Response(child.stderr).bytes(),
            child.exited,
          ]);
          expect(stdout).toEqual(expected);
          expect(stderr).toHaveLength(0);
          expect(exit).toEqual({ exitCode: 0, signal: 0, coreDumped: false });
        } finally {
          await child.dispose();
        }
        expect(host.processes.size).toBe(0);
      }
      expect(filesystem.fileBytes).toEqual(canonicalFileByteSelection);
    } finally {
      await host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      database.close();
    }
  });
});
