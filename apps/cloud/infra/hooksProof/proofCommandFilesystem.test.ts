import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { describe, expect, it } from "vite-plus/test";
import { KernelCommandExecutor } from "../../src/kernel/KernelCommandExecutor.ts";
import { ABI_VERSION } from "../../src/kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import type { Storage } from "../../src/kernel/storage.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createCodexHookRuntime } from "./codexRuntime.ts";
import { standardProofFilledWrite, STANDARD_PROOF_WRITE } from "./standardProofAdapter.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text);

function trackPins(storage: Storage) {
  const pins = new Map<bigint, number>();
  const tracked: Storage = {
    ...storage,
    retain(inode) {
      storage.retain(inode);
      pins.set(inode, (pins.get(inode) ?? 0) + 1);
    },
    release(inode) {
      storage.release(inode);
      const count = pins.get(inode) ?? 0;
      if (count <= 1) pins.delete(inode);
      else pins.set(inode, count - 1);
    },
  };
  return { storage: tracked, pins };
}

function fixture() {
  const database = createProofTestStorage();
  const rawStorage = createFacetSqliteStorage(database.storage, () => 1n);
  const tracked = trackPins(rawStorage);
  const storage = tracked.storage;
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: {
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000, groups: [] },
      umask: 0o022,
    },
  });
  filesystem.mkdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const runtime = createCodexHookRuntime(
    (registry) => {
      const manifest = {
        name: "proof/raw-cat",
        version: "1",
        abiVersion: ABI_VERSION,
        requiredCapabilities: [],
        entrypoint: "proof-raw-cat-v1",
      } as const;
      if (registry.register(manifest).status !== "ok")
        throw new Error("Could not register proof cat");
      return {
        bindings: new Map([
          [
            "/bin/cat",
            {
              manifest,
              implementation: {
                kind: "javascript" as const,
                runInline({
                  filesystem: child,
                  args,
                }: {
                  filesystem: KernelFileSystem;
                  args: readonly string[];
                }) {
                  const path = args.at(-1);
                  if (!path) return 2;
                  const fd = child.open(path, KernelOpenFlags.O_RDONLY);
                  try {
                    const output = new Uint8Array(Number(child.fstat(fd).size));
                    const count = child.read(fd, output, null);
                    child.write(1, output.subarray(0, count), null);
                    return 0;
                  } finally {
                    child.close(fd);
                  }
                },
              },
            },
          ],
        ]),
        async drain() {},
      };
    },
    wakes,
    new ChildWorkerCapacity(4, { owner: "test/infra-hooksproof-proofcommandfilesystem-test-1" }),
  );
  return {
    database,
    filesystem,
    pins: tracked.pins,
    runtime,
    input: {
      filesystem,
      storage,
      facetStorage: database.storage,
      host: runtime.host,
      wakes,
      env: {
        CHILD_WORKERS: {},
        CODE_GENERATION: {
          async open(): Promise<never> {
            throw new Error("Setup must not execute generated code");
          },
        },
      },
    },
    async close() {
      await runtime.host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

describe("Codex proof command filesystem", () => {
  it("isolates regular descriptors while preserving the canonical workspace and selected command view", async () => {
    const test = fixture();
    let configured: ReturnType<typeof test.runtime.configure> | undefined;
    let finished = false;
    let heldFd: number | undefined;
    let afterCaptureFd: number | undefined;
    try {
      const source = test.input.filesystem;
      const fd = source.open(
        "/workspace/proof.txt",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      source.write(fd, bytes(STANDARD_PROOF_WRITE), null);
      source.close(fd);

      heldFd = source.open("/workspace/proof.txt", KernelOpenFlags.O_RDONLY);
      const firstByte = new Uint8Array(1);
      expect(source.read(heldFd, firstByte, null)).toBe(1);
      expect(decoder.decode(firstByte)).toBe(STANDARD_PROOF_WRITE.slice(0, 1));
      const heldDescriptor = source.descriptors.get(heldFd);
      const originalView = heldDescriptor.byteView;
      const originalOffset = heldDescriptor.offset;

      configured = test.runtime.configure(test.input);
      await configured.prepare();
      const commandFilesystem = configured.commandFilesystem;
      expect(commandFilesystem.cwd).toBe(source.cwd);
      expect(commandFilesystem.resolve("/").mount.storage).toBe(source.resolve("/").mount.storage);
      expect(commandFilesystem.descriptors.has(heldFd)).toBe(false);
      expect(
        [...commandFilesystem.descriptors.entries()].every(
          ([, descriptor]) => descriptor.kind !== "file",
        ),
      ).toBe(true);

      afterCaptureFd = source.open("/workspace/proof.txt", KernelOpenFlags.O_RDONLY);
      expect(commandFilesystem.descriptors.has(afterCaptureFd)).toBe(false);

      const command = {
        executable: "/bin/cat",
        argv: ["cat", "/workspace/proof.txt"],
        cwd: "/workspace",
        env: { HOME: "/home/codex", PATH: "/bin" },
      };
      const forwarder = {
        async spawn(): Promise<never> {
          throw new Error("Proof command must remain in the isolate");
        },
      };
      const oldFilesystemExecutor = new KernelCommandExecutor({
        host: test.runtime.host,
        filesystem: source,
        forwarder,
      });
      await expect(
        oldFilesystemExecutor.spawn(command, new AbortController().signal),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(test.runtime.host.processes.size).toBe(1);

      const commandExecutor = new KernelCommandExecutor({
        host: test.runtime.host,
        filesystem: commandFilesystem,
        forwarder,
      });
      const child = await commandExecutor.spawn(command, new AbortController().signal);
      const writer = child.stdin.getWriter();
      await writer.close();
      writer.releaseLock();
      const [stdout, stderr, exit] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      await child.dispose();
      expect({
        stdout: decoder.decode(stdout),
        stderr: decoder.decode(stderr),
        exit,
      }).toMatchObject({
        stdout: standardProofFilledWrite(),
        stderr: "",
        exit: { exitCode: 0, signal: 0, coreDumped: false },
      });

      expect(source.descriptors.get(heldFd)).toMatchObject({ offset: originalOffset });
      expect(source.descriptors.get(heldFd).byteView).toBe(originalView);
      const remaining = new Uint8Array(STANDARD_PROOF_WRITE.length);
      const count = source.read(heldFd, remaining, null);
      expect(decoder.decode(remaining.subarray(0, count))).toBe(STANDARD_PROOF_WRITE.slice(1));

      await configured.finish({ exit: 0, failure: undefined });
      finished = true;
      expect([...commandFilesystem.descriptors.entries()]).toEqual([]);
      expect(test.runtime.host.processes.size).toBe(1);
    } finally {
      if (configured && !finished) {
        await configured.finish({ exit: 0, failure: undefined });
      }
      if (heldFd !== undefined && test.filesystem.descriptors.has(heldFd))
        test.filesystem.close(heldFd);
      if (afterCaptureFd !== undefined && test.filesystem.descriptors.has(afterCaptureFd))
        test.filesystem.close(afterCaptureFd);
      await test.close();
    }
    expect(test.pins.size).toBe(0);
  });
});
