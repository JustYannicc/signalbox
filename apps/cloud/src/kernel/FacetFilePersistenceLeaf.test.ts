import { describe, expect, it } from "vite-plus/test";
import type { FilePersistencePorts, ForkCommit } from "./FilePersistencePorts.ts";
import { FacetFileHydrationError, createFacetFilePersistence } from "./FacetFilePersistence.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import { createMemoryFilePersistencePorts } from "./MemoryFilePersistencePorts.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
const clock = () => 1_800_000_000_000_000_001n;

function rig(ports?: FilePersistencePorts) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const persistence = createFacetFilePersistence(database.storage, clock, {
    wakes,
    ...(ports ? { ports } : {}),
  });
  return {
    ...database,
    persistence,
    close() {
      persistence.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function leafRead(
  persistence: ReturnType<typeof createFacetFilePersistence>,
  inode: bigint,
  size: number,
  signal?: AbortSignal,
) {
  return persistence.runLeaf(() => {
    const bytes = new Uint8Array(size);
    persistence.storage.readInto(inode, 0n, bytes);
    return bytes;
  }, signal);
}

function markLazy(
  persistence: ReturnType<typeof createFacetFilePersistence>,
  name: string,
  size: number,
) {
  const inode = persistence.storage.create(persistence.storage.root, name, {
    type: "file",
    exclusive: true,
  });
  persistence.storage.truncate(inode, BigInt(size));
  persistence.markUnhydrated({ inode, path: `/${name}`, at: base, size: BigInt(size) });
  return inode;
}

describe("facet file persistence leaf runner", () => {
  it("lets one waiter cancel while another completes the shared fetch", async () => {
    const memory = createMemoryFilePersistencePorts();
    const bytes = new Uint8Array([3, 5, 7]);
    memory.seedFile(base, "/lazy", bytes);
    const started = deferred();
    const release = deferred();
    const fixture = rig({
      commits: memory.commits,
      hydration: {
        async fetch(input) {
          started.resolve();
          await release.promise;
          return memory.hydration.fetch(input);
        },
      },
    });
    try {
      const inode = markLazy(fixture.persistence, "lazy", bytes.byteLength);
      const cancellation = new AbortController();
      const reason = new Error("caller left");
      const cancelled = leafRead(fixture.persistence, inode, bytes.byteLength, cancellation.signal);
      const remaining = leafRead(fixture.persistence, inode, bytes.byteLength);
      await started.promise;

      cancellation.abort(reason);
      await expect(cancelled).rejects.toBe(reason);
      release.resolve();
      await expect(remaining).resolves.toEqual(bytes);
      expect(memory.fetchCalls).toHaveLength(1);
    } finally {
      release.resolve();
      fixture.close();
    }
  });

  it("rethrows an ordinary EAGAIN object without treating it as pending content", async () => {
    const fixture = rig();
    const error = Object.assign(new Error("ordinary EAGAIN"), { code: "EAGAIN" });
    try {
      await expect(
        fixture.persistence.runLeaf(() => {
          throw error;
        }),
      ).rejects.toBe(error);
    } finally {
      fixture.close();
    }
  });

  it("retries only the supplied leaf after hydration", async () => {
    const memory = createMemoryFilePersistencePorts();
    const expected = new Uint8Array([9, 8]);
    memory.seedFile(base, "/lazy", expected);
    const fixture = rig(memory);
    try {
      const inode = markLazy(fixture.persistence, "lazy", expected.byteLength);
      const count = fixture.persistence.storage.create(fixture.persistence.storage.root, "count", {
        type: "file",
        exclusive: true,
      });
      fixture.persistence.storage.write(count, 0n, new Uint8Array([0]));
      let commandCalls = 0;
      let leafCalls = 0;
      const command = () => {
        commandCalls++;
        fixture.persistence.storage.append(count, new Uint8Array([1]));
        return fixture.persistence.runLeaf(() => {
          leafCalls++;
          const bytes = new Uint8Array(expected.byteLength);
          fixture.persistence.storage.readInto(inode, 0n, bytes);
          return bytes;
        });
      };

      await expect(command()).resolves.toEqual(expected);
      const counter = new Uint8Array(2);
      fixture.persistence.storage.readInto(count, 0n, counter);
      expect(commandCalls).toBe(1);
      expect(leafCalls).toBe(2);
      expect(counter).toEqual(new Uint8Array([0, 1]));
    } finally {
      fixture.close();
    }
  });

  it("preserves typed fetch failures until explicit hydration retry", async () => {
    const memory = createMemoryFilePersistencePorts();
    const expected = new Uint8Array([4, 2]);
    memory.seedFile(base, "/lazy", expected);
    const persistenceError = { code: "NOT_FOUND" as const, message: "Remote file is gone" };
    let fetchCount = 0;
    const ports: FilePersistencePorts = {
      commits: memory.commits,
      hydration: {
        async fetch(input) {
          fetchCount++;
          if (fetchCount === 1) return { status: "error", error: persistenceError };
          return memory.hydration.fetch(input);
        },
      },
    };
    const fixture = rig(ports);
    try {
      const inode = markLazy(fixture.persistence, "lazy", expected.byteLength);
      const first = await leafRead(fixture.persistence, inode, expected.byteLength).catch(
        (error: unknown) => error,
      );
      expect(first).toBeInstanceOf(FacetFileHydrationError);
      if (!(first instanceof FacetFileHydrationError))
        throw new Error("Expected hydration failure");
      expect(first.code).toBe("NOT_FOUND");
      expect(first.message).toBe(persistenceError.message);
      expect(first.persistenceError).toBe(persistenceError);

      const cached = await leafRead(fixture.persistence, inode, expected.byteLength).catch(
        (error: unknown) => error,
      );
      expect(cached).toBeInstanceOf(FacetFileHydrationError);
      expect(fetchCount).toBe(1);

      fixture.persistence.retryHydration(inode);
      await expect(leafRead(fixture.persistence, inode, expected.byteLength)).resolves.toEqual(
        expected,
      );
      expect(fetchCount).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("owner disposal aborts the fetch and rejects its waiting leaf", async () => {
    const started = deferred();
    const aborted = deferred();
    let fetchSignal: AbortSignal | undefined;
    const fixture = rig({
      commits: createMemoryFilePersistencePorts().commits,
      hydration: {
        fetch(input) {
          fetchSignal = input.signal;
          started.resolve();
          return new Promise((resolve) => {
            input.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve({
                  status: "error",
                  error: { code: "CANCELLED", message: "Fetch aborted" },
                });
              },
              { once: true },
            );
          });
        },
      },
    });
    try {
      const inode = markLazy(fixture.persistence, "lazy", 1);
      const waiting = leafRead(fixture.persistence, inode, 1);
      await started.promise;
      fixture.persistence.dispose();
      await aborted.promise;

      const cancelled = await waiting.catch((error: unknown) => error);
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancelled).toBeInstanceOf(FacetFileHydrationError);
      expect(cancelled).toMatchObject({
        code: "CANCELLED",
        message: "File persistence owner exited",
      });
    } finally {
      fixture.close();
    }
  });
});
