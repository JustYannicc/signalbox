import { describe, expect, it } from "vite-plus/test";
import { KernelDescriptors, type KernelDescriptorResource } from "./KernelDescriptors.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";
import { WasiHost } from "./wasi/internal_wasi_host.ts";
import {
  FDFLAGS,
  RIGHTS,
  WasiDescriptorTable,
  type WasiPollResult,
} from "./wasi/internal_wasi_descriptors.ts";
import { WasiError, WasiMemory } from "./wasi/internal_wasi_memory.ts";

const inertStdio = {};

describe("KernelDescriptors", () => {
  it("attaches resources to the shared descriptor table and closes after the last alias", () => {
    const table = new WasiDescriptorTable([inertStdio, inertStdio, inertStdio]);
    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(table, wakes);
    const resource = new TestResource();
    try {
      const fd = descriptors.register(resource);
      const descriptor = table.get(fd);
      expect(fd).toBe(3);
      expect(descriptors.resource(fd)).toBe(resource);
      expect(descriptor.kind).toBe("stdio");
      expect(descriptor.stdioIndex).toBeUndefined();
      expect(descriptor.flags).toBe(FDFLAGS.NONBLOCK);
      expect(descriptor.rightsBase).toBe(
        RIGHTS.FD_READ | RIGHTS.FD_WRITE | RIGHTS.FD_FDSTAT_SET_FLAGS | RIGHTS.POLL_FD_READWRITE,
      );
      expect(descriptor.rightsInheriting).toBe(0n);

      const duplicate = descriptors.duplicate(fd);
      const duplicateAtMinimum = descriptors.duplicate(fd, 6);
      expect(duplicate).toBe(4);
      expect(duplicateAtMinimum).toBe(6);
      expect(table.get(duplicate).stdio).toBe(descriptor.stdio);

      const childTable = table.fork([
        { parentFd: duplicate, childFd: 70 },
        { parentFd: duplicateAtMinimum, childFd: 71 },
      ]);
      const childDescriptors = new KernelDescriptors(childTable, wakes);
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
      for (const fd of [3, 4, 6]) {
        if (table.has(fd)) descriptors.close(fd);
      }
      wakes.dispose();
    }
  });

  it("does not take resource ownership when descriptor allocation fails", () => {
    class FullDescriptorTable extends WasiDescriptorTable {
      override allocate(): number {
        throw new WasiError(33);
      }
    }

    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(new FullDescriptorTable(), wakes);
    const resource = new TestResource();
    try {
      expect(() => descriptors.register(resource)).toThrow(
        expect.objectContaining({ code: "EMFILE" }),
      );
      expect(resource.closeCalls).toBe(0);
    } finally {
      wakes.dispose();
    }
  });

  it("uses the table resource through WASI poll_oneoff for data and EOF readiness", async () => {
    const table = new WasiDescriptorTable([inertStdio, inertStdio, inertStdio]);
    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(table, wakes);
    const resource = new TestResource();
    const fd = descriptors.register(resource);
    const memory = new WasiMemory();
    memory.set(new WebAssembly.Memory({ initial: 1 }));
    const host = new WasiHost(memory, [], [], true, table);
    try {
      writePollSubscription(memory, fd, 1);
      const dataPoll = runAsync(host.imports.poll_oneoff(0, 64, 1, 96));
      expect(wakes.size).toBe(1);
      resource.setReady("read", { bytes: 12n });
      expect(await dataPoll).toBe(0);
      expect(readPollEvent(memory)).toMatchObject({
        errno: 0,
        type: 1,
        bytes: 12n,
        hangup: false,
      });
      expect(wakes.size).toBe(0);

      resource.setReady("read", { bytes: 0n, hangup: true }, false);
      writePollSubscription(memory, fd, 1);
      expect(await runAsync(host.imports.poll_oneoff(0, 64, 1, 96))).toBe(0);
      expect(readPollEvent(memory)).toMatchObject({ errno: 0, type: 1, bytes: 0n, hangup: true });
      expect(wakes.size).toBe(0);
    } finally {
      descriptors.close(fd);
      wakes.dispose();
    }
  });

  it("cancels a pending poll input and detaches its readiness subscription", async () => {
    const table = new WasiDescriptorTable([inertStdio, inertStdio, inertStdio]);
    const wakes = new KernelWakeRegistry();
    const descriptors = new KernelDescriptors(table, wakes);
    const resource = new TestResource();
    const fd = descriptors.register(resource);
    const controller = new AbortController();
    const stdio = table.get(fd).stdio;
    try {
      expect(stdio).toBeDefined();
      const waiting = Promise.resolve(stdio!.poll!("read", controller.signal));
      expect(wakes.size).toBe(1);
      expect(resource.subscriberCount("read")).toBe(1);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ code: "ECANCELED" });
      expect(wakes.size).toBe(0);
      expect(resource.subscriberCount("read")).toBe(0);
    } finally {
      descriptors.close(fd);
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
  closeCalls = 0;
  onSubscribe: ((direction: "read" | "write", notify: () => void) => void) | undefined;

  ready(direction: "read" | "write"): WasiPollResult | undefined {
    return this.#readiness.get(direction);
  }

  subscribe(direction: "read" | "write", notify: () => void): () => void {
    const listeners = this.#listeners.get(direction);
    if (listeners === undefined) throw new Error("Missing readiness listeners");
    listeners.add(notify);
    this.onSubscribe?.(direction, notify);
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

function writePollSubscription(memory: WasiMemory, fd: number, type: number): void {
  const subscription = memory.view(0, 48);
  new Uint8Array(subscription.buffer, subscription.byteOffset, subscription.byteLength).fill(0);
  subscription.setBigUint64(0, 0xabcden, true);
  subscription.setUint8(8, type);
  subscription.setUint32(16, fd, true);
}

function readPollEvent(memory: WasiMemory) {
  const event = memory.view(64, 32);
  return {
    userdata: event.getBigUint64(0, true),
    errno: event.getUint16(8, true),
    type: event.getUint8(10),
    bytes: event.getBigUint64(16, true),
    hangup: event.getUint16(24, true) === 1,
  };
}
