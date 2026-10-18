import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelDescriptors, type KernelDescriptorResource } from "./KernelDescriptors.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";
import type { WasiPollResult, WasiStdio } from "./Wasi.ts";

const now = () => 1_800_000_000_000_000_001n;
const inertStdio: WasiStdio = {};

describe("KernelDescriptors", () => {
  it("exposes pollable nonblocking resources through the WASI fdstat contract", async () => {
    const { filesystem, fixture } = fileSystem();
    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(filesystem.descriptors, wakes);
    const resource = new TestResource();
    let wasi: ReturnType<typeof createKernelAsyncWasi> | undefined;
    try {
      const fd = descriptors.register(resource);
      expect(filesystem.descriptors.has(fd)).toBe(true);
      expect(descriptors.resource(fd)).toBe(resource);

      wasi = createKernelAsyncWasi({ filesystem, wakes });
      const instance = new WebAssembly.Instance(
        wasmImportReactor("wasi_snapshot_preview1", "fd_fdstat_get", ["i32", "i32"], ["i32"]),
        wasi.wasi.getImportObject(),
      );
      await wasi.wasi.initialize(instance);
      const memory = guestMemory(instance);
      expect(await wasi.wasi.run(guestRun(instance), fd, 64)).toBe(0);
      const stat = new DataView(memory.buffer, 64, 24);
      expect(stat.getUint8(0)).toBe(2);
      expect(stat.getUint16(2, true)).toBe(4);
      const rights = stat.getBigUint64(8, true);
      expect(rights & (1n << 1n)).not.toBe(0n);
      expect(rights & (1n << 3n)).not.toBe(0n);
      expect(rights & (1n << 6n)).not.toBe(0n);
      expect(rights & (1n << 27n)).not.toBe(0n);
      expect(rights & (1n << 21n)).toBe(0n);
    } finally {
      await wasi?.wasi.close();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("shares a resource across table dup and fork until the final close", () => {
    const { filesystem, fixture } = fileSystem();
    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(filesystem.descriptors, wakes);
    const resource = new TestResource();
    const parentFds: number[] = [];
    let childTable: typeof filesystem.descriptors | undefined;
    let childDescriptors: KernelDescriptors | undefined;
    try {
      const fd = descriptors.register(resource);
      parentFds.push(fd);
      expect(filesystem.descriptors.has(fd)).toBe(true);
      expect(descriptors.resource(fd)).toBe(resource);

      const duplicate = descriptors.duplicate(fd);
      const duplicateAtMinimum = descriptors.duplicate(fd, duplicate + 1);
      parentFds.push(duplicate, duplicateAtMinimum);
      expect(duplicate).toBe(fd + 1);
      expect(duplicateAtMinimum).toBe(duplicate + 1);

      childTable = filesystem.descriptors.fork([
        { parentFd: duplicate, childFd: 70 },
        { parentFd: duplicateAtMinimum, childFd: 71 },
      ]);
      childDescriptors = new KernelDescriptors(childTable, wakes);
      expect(childDescriptors.resource(70)).toBe(resource);
      expect(childDescriptors.resource(71)).toBe(resource);

      descriptors.close(fd);
      descriptors.close(duplicate);
      descriptors.close(duplicateAtMinimum);
      expect(resource.closeCalls).toBe(0);
      childDescriptors.close(70);
      expect(resource.closeCalls).toBe(0);
      childDescriptors.close(71);
      expect(resource.closeCalls).toBe(1);
      expect(wakes.size).toBe(0);
    } finally {
      for (const fd of [70, 71]) {
        if (childTable?.has(fd)) childDescriptors?.close(fd);
      }
      for (const fd of parentFds) {
        if (filesystem.descriptors.has(fd)) descriptors.close(fd);
      }
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("does not transfer ownership if descriptor allocation fails", () => {
    const { filesystem, fixture } = fileSystem();
    const wakes = new KernelWakeRegistry();
    const resource = new TestResource();
    const fullTable = new Proxy(filesystem.descriptors, {
      get(target, property) {
        if (property === "allocate") {
          return () => {
            throw Object.assign(new Error("Descriptor table is full"), { code: "EMFILE" });
          };
        }
        return Reflect.get(target, property, target);
      },
    });
    const descriptors = new KernelDescriptors(fullTable, wakes);
    try {
      expect(() => descriptors.register(resource)).toThrow(
        expect.objectContaining({ code: "EMFILE" }),
      );
      expect(resource.closeCalls).toBe(0);
    } finally {
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("reports data and EOF through the public WASI poll_oneoff import", async () => {
    const { filesystem, fixture } = fileSystem();
    const wakes = new KernelWakeRegistry();
    const { wasi, descriptors } = createKernelAsyncWasi({ filesystem, wakes });
    const resource = new TestResource();
    const fd = descriptors.register(resource);
    const instance = new WebAssembly.Instance(
      wasmImportReactor(
        "wasi_snapshot_preview1",
        "poll_oneoff",
        ["i32", "i32", "i32", "i32"],
        ["i32"],
      ),
      wasi.getImportObject(),
    );
    try {
      await wasi.initialize(instance);
      const memory = guestMemory(instance);
      writePollSubscription(memory, fd);
      const pending = wasi.run(guestRun(instance), 0, 64, 1, 96);
      await resource.subscribed;
      expect(wakes.size).toBe(1);
      resource.setReady("read", { bytes: 12n });
      expect(await pending).toBe(0);
      expect(readPollEvent(memory)).toMatchObject({ errno: 0, type: 1, bytes: 12n, hangup: false });
      expect(wakes.size).toBe(0);

      resource.setReady("read", { bytes: 0n, hangup: true }, false);
      writePollSubscription(memory, fd);
      expect(await wasi.run(guestRun(instance), 0, 64, 1, 96)).toBe(0);
      expect(readPollEvent(memory)).toMatchObject({ errno: 0, type: 1, bytes: 0n, hangup: true });
      expect(wakes.size).toBe(0);
      await wasi.close();
      expect(filesystem.descriptors.has(fd)).toBe(true);
      descriptors.close(fd);
      expect(resource.closeCalls).toBe(1);
    } finally {
      await wasi.close();
      if (filesystem.descriptors.has(fd)) descriptors.close(fd);
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });

  it("cancels a waiting guest poll and detaches the readiness subscription", async () => {
    const { filesystem, fixture } = fileSystem();
    const wakes = new KernelWakeRegistry();
    const { wasi, descriptors } = createKernelAsyncWasi({ filesystem, wakes });
    const resource = new TestResource();
    const fd = descriptors.register(resource);
    const instance = new WebAssembly.Instance(
      wasmImportReactor(
        "wasi_snapshot_preview1",
        "poll_oneoff",
        ["i32", "i32", "i32", "i32"],
        ["i32"],
      ),
      wasi.getImportObject(),
    );
    try {
      await wasi.initialize(instance);
      const memory = guestMemory(instance);
      writePollSubscription(memory, fd);
      const pending = wasi.run(guestRun(instance), 0, 64, 1, 96);
      await resource.subscribed;
      expect(wakes.size).toBe(1);
      expect(resource.subscriberCount("read")).toBe(1);

      wakes.dispose();
      expect(await pending).toBe(0);
      expect(readPollEvent(memory)).toMatchObject({ errno: 11, type: 1 });
      expect(wakes.size).toBe(0);
      expect(resource.subscriberCount("read")).toBe(0);
      await wasi.close();
      descriptors.close(fd);
      expect(resource.closeCalls).toBe(1);
    } finally {
      await wasi.close();
      if (filesystem.descriptors.has(fd)) descriptors.close(fd);
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    }
  });
});

class TestResource implements KernelDescriptorResource {
  readonly #readiness = new Map<"read" | "write", WasiPollResult>();
  readonly #listeners = new Map<"read" | "write", Set<() => void>>([
    ["read", new Set()],
    ["write", new Set()],
  ]);
  readonly subscribed: Promise<void>;
  closeCalls = 0;
  #resolveSubscribed: (() => void) | undefined;

  constructor() {
    this.subscribed = new Promise((resolve) => {
      this.#resolveSubscribed = resolve;
    });
  }

  ready(direction: "read" | "write"): WasiPollResult | undefined {
    return this.#readiness.get(direction);
  }

  subscribe(direction: "read" | "write", notify: () => void): () => void {
    const listeners = this.#listeners.get(direction);
    if (listeners === undefined) throw new Error("Missing readiness listeners");
    listeners.add(notify);
    this.#resolveSubscribed?.();
    this.#resolveSubscribed = undefined;
    return () => {
      listeners.delete(notify);
    };
  }

  setReady(direction: "read" | "write", result: WasiPollResult, notify = true): void {
    this.#readiness.set(direction, result);
    if (notify) this.notify(direction);
  }

  subscriberCount(direction: "read" | "write"): number {
    return this.#listeners.get(direction)?.size ?? 0;
  }

  close(): void {
    this.closeCalls++;
  }

  notify(direction: "read" | "write"): void {
    for (const listener of this.#listeners.get(direction) ?? []) listener();
  }
}

function fileSystem() {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, now);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: [inertStdio, inertStdio, inertStdio],
  });
  return { filesystem, fixture };
}

function guestMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = (instance.exports as { memory?: unknown }).memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory export is missing");
  return memory;
}

function guestRun(instance: WebAssembly.Instance): (...args: Array<number | bigint>) => unknown {
  const run = (instance.exports as { run?: unknown }).run;
  if (typeof run !== "function") throw new Error("Guest run export is missing");
  return run as (...args: Array<number | bigint>) => unknown;
}

function writePollSubscription(memory: WebAssembly.Memory, fd: number): void {
  const view = new DataView(memory.buffer);
  view.setBigUint64(0, 0xabcden, true);
  view.setUint8(8, 1);
  view.setUint32(16, fd, true);
}

function readPollEvent(memory: WebAssembly.Memory) {
  const event = new DataView(memory.buffer, 64, 32);
  return {
    userdata: event.getBigUint64(0, true),
    errno: event.getUint16(8, true),
    type: event.getUint8(10),
    bytes: event.getBigUint64(16, true),
    hangup: event.getUint16(24, true) === 1,
  };
}
