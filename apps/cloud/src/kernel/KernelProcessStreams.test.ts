import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, type WasiStdio } from "./KernelFileSystem.ts";
import { KernelProgramHost } from "./KernelProgramHost.ts";
import { KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import { createKernelProcessStreams } from "./KernelProcessStreams.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function harness(stdio?: readonly [WasiStdio, WasiStdio, WasiStdio]) {
  const fixture = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 1n) }],
    ...(stdio === undefined ? {} : { stdio }),
  });
  const host = new KernelProgramHost({ registry: new KernelProgramRegistry(), wakes });
  const piped = host.preparePiped({ filesystem });
  return {
    filesystem,
    host,
    piped,
    wakes,
    async close() {
      await piped.prepared.release();
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

describe("borrowed process descriptor streams", () => {
  it("moves binary input and output across bounded async pipes", async () => {
    const h = harness();
    const payload = Uint8Array.from({ length: 196_613 }, (_, i) => i % 256);
    try {
      const streams = createKernelProcessStreams(h.piped.prepared.filesystem);
      const writer = h.piped.stdin.getWriter();
      const input = new Response(streams.stdin).arrayBuffer();
      await writer.write(payload);
      await writer.close();
      expect(new Uint8Array(await input)).toEqual(payload);
      const output = new Response(h.piped.stdout).arrayBuffer();
      const stdout = streams.stdout.getWriter();
      await stdout.write(payload);
      await stdout.close();
      expect(h.piped.prepared.filesystem.descriptors.has(1)).toBe(true);
      await h.piped.prepared.release();
      expect(new Uint8Array(await output)).toEqual(payload);
      expect(h.wakes.size).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("keeps cancellation pending until an uncancellable borrowed read settles", async () => {
    let finishRead!: (count: number) => void;
    const gate = new Promise<number>((resolve) => {
      finishRead = resolve;
    });
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const h = harness([
      {
        readInto: () => {
          markReading();
          return gate;
        },
      },
      { write: (data) => data.byteLength },
      { write: (data) => data.byteLength },
    ]);
    try {
      const streams = createKernelProcessStreams(h.filesystem);
      const reader = streams.stdin.getReader();
      const read = reader.read();
      await reading;
      let cancelled = false;
      const cancellation = reader.cancel().then(() => {
        cancelled = true;
      });
      expect(cancelled).toBe(false);
      expect(h.filesystem.descriptors.has(0)).toBe(true);
      finishRead(0);
      await cancellation;
      await read;
      expect(cancelled).toBe(true);
      expect(h.filesystem.descriptors.has(0)).toBe(true);
    } finally {
      finishRead(0);
      await h.close();
    }
  });

  it("cancels blocked input without closing its borrowed fd or leaking a wake", async () => {
    const h = harness();
    const signal = new AbortController();
    try {
      await Promise.all([h.piped.stdout.cancel(), h.piped.stderr.cancel()]);
      const streams = createKernelProcessStreams(h.piped.prepared.filesystem, {
        signal: signal.signal,
      });
      const reader = streams.stdin.getReader();
      const reading = reader.read();
      signal.abort();
      await expect(reading).rejects.toMatchObject({ name: "AbortError" });
      expect(h.piped.prepared.filesystem.descriptors.has(0)).toBe(true);
      expect(h.wakes.size).toBe(0);
    } finally {
      await h.close();
    }
  });
});
