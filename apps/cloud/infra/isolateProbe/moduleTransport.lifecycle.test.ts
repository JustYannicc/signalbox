import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { encodeModuleTransport, openModuleTransport } from "./moduleTransport.ts";

const utf8 = (value: string) => new TextEncoder().encode(value);
function header(modules: { name: string; type: string; byteLength: number }[]) {
  const metadata = utf8(JSON.stringify({ input: { id: "lazy" }, modules }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, metadata.byteLength, false);
  return [prefix, metadata];
}
function chunks(...values: Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < values.length) controller.enqueue(values[index++]!);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

describe("module transport lifecycle", () => {
  it("reads metadata without pulling bodies, then supplies the full map once on a cache miss", async () => {
    let bodyPulls = 0;
    const source = "\uFEFFexport const greeting = 'Grüezi 🌍';\r\n";
    const bytes = utf8(source);
    const parts = header([{ name: "main.js", type: "js", byteLength: bytes.length }]);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = parts.shift();
          if (next) controller.enqueue(next);
          else if (bodyPulls++ === 0) controller.enqueue(bytes);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const transport = await openModuleTransport(stream);
    expect(transport.input).toEqual({ id: "lazy" });
    expect(bodyPulls).toBe(0);
    expect(stream.locked).toBe(true);
    expect(await transport.readModules()).toEqual({ "main.js": { js: source } });
    await transport.discard();
    await expect(transport.readModules()).rejects.toThrow("already consumed");
    expect(stream.locked).toBe(false);
  });

  it.each([false, true])("allocates a WASM body only when materializing: %s", async (retain) => {
    const bytes = new Uint8Array(150000).fill(255);
    const stream = encodeModuleTransport({}, [{ name: "engine.wasm", type: "wasm", bytes }]);
    const allocations: number[] = [];
    const native = Uint8Array;
    vi.stubGlobal(
      "Uint8Array",
      new Proxy(native, {
        construct(target, args) {
          if (typeof args[0] === "number") allocations.push(args[0]);
          return Reflect.construct(target, args);
        },
      }),
    );
    try {
      const transport = await openModuleTransport(stream);
      if (retain)
        expect(await transport.readModules()).toEqual({ "engine.wasm": { wasm: bytes.buffer } });
      else await transport.discard();
      expect(allocations.includes(bytes.byteLength)).toBe(retain);
      expect(stream.locked).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("joins an in-flight module read when finishing the upload instead of consuming it twice", async () => {
    const ready = Promise.withResolvers<void>();
    const parts = header([{ name: "main.js", type: "js", byteLength: 9 }]);
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const next = parts.shift();
          if (next) controller.enqueue(next);
          else {
            await ready.promise;
            controller.enqueue(utf8("export {}"));
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const transport = await openModuleTransport(stream);
    const modules = transport.readModules();
    const finished = transport.discard();
    ready.resolve();
    expect(await modules).toEqual({ "main.js": { js: "export {}" } });
    await finished;
    expect(stream.locked).toBe(false);
  });

  it("validates discarded text in bounded slices even if the source coalesces a whole module", async () => {
    const bytes = utf8("x".repeat(65535) + "🌍" + "x".repeat(80000));
    const stream = chunks(
      ...header([{ name: "source.js", type: "js", byteLength: bytes.length }]),
      bytes,
    );
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const transport = await openModuleTransport(stream);
      expect(await transport.discard()).toBeUndefined();
      const sizes = decode.mock.calls.map(([input]) =>
        ArrayBuffer.isView(input) ? input.byteLength : 0,
      );
      expect(Math.max(...sizes)).toBe(65536);
      expect(stream.locked).toBe(false);
      await expect(transport.readModules()).rejects.toThrow("already consumed");
    } finally {
      decode.mockRestore();
    }
  });

  it.each(["js", "cjs", "text", "wasm"])(
    "rejects truncated %s bodies when discarding",
    async (type) => {
      const stream = chunks(...header([{ name: "short", type, byteLength: 2 }]), utf8("x"));
      const transport = await openModuleTransport(stream);
      await expect(transport.discard()).rejects.toThrow("Truncated module short");
      await expect(transport.discard()).rejects.toThrow("Truncated module short");
      expect(stream.locked).toBe(false);
    },
  );

  it.each(["js", "cjs", "text"])(
    "rejects invalid and incomplete UTF-8 in discarded %s",
    async (type) => {
      for (const bytes of [new Uint8Array([255]), new Uint8Array([0xe2, 0x82])]) {
        const stream = chunks(
          ...header([{ name: "bad", type, byteLength: bytes.length }]),
          ...Array.from(bytes, (byte) => new Uint8Array([byte])),
        );
        const transport = await openModuleTransport(stream);
        await expect(transport.discard()).rejects.toThrow();
        expect(stream.locked).toBe(false);
      }
    },
  );

  it("rejects trailing bytes and preserves that error if source cancellation fails", async () => {
    const reasons: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of header([])) controller.enqueue(part);
        controller.enqueue(new Uint8Array([0]));
      },
      cancel(reason) {
        reasons.push(reason);
        throw new Error("cancel failed");
      },
    });
    const transport = await openModuleTransport(stream);
    await expect(transport.discard()).rejects.toThrow("Trailing module transport bytes");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBeInstanceOf(Error);
    expect(stream.locked).toBe(false);
  });

  it.each([false, true])(
    "propagates body reader failures and unlocks while materializing: %s",
    async (retain) => {
      const failure = new Error("body source failed");
      const parts = header([{ name: "engine.wasm", type: "wasm", byteLength: 2 }]);
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const next = parts.shift();
            if (next) controller.enqueue(next);
            else controller.error(failure);
          },
        },
        { highWaterMark: 0 },
      );
      const transport = await openModuleTransport(stream);
      await expect(retain ? transport.readModules() : transport.discard()).rejects.toBe(failure);
      await expect(transport.discard()).rejects.toBe(failure);
      expect(stream.locked).toBe(false);
    },
  );

  it("cancels an unconsumed request once without pulling its body", async () => {
    const reason = new Error("invalid input");
    const reasons: unknown[] = [];
    const parts = header([{ name: "engine.wasm", type: "wasm", byteLength: 2 }]);
    let bodyPulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = parts.shift();
          if (next) controller.enqueue(next);
          else bodyPulls++;
        },
        cancel(reason) {
          reasons.push(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const transport = await openModuleTransport(stream);
    await transport.cancel(reason);
    await transport.cancel(reason);
    expect(bodyPulls).toBe(0);
    expect(reasons).toEqual([reason]);
    expect(stream.locked).toBe(false);
    await expect(transport.readModules()).rejects.toThrow("already consumed or cancelled");
    await expect(transport.discard()).rejects.toThrow("already consumed or cancelled");
  });
});
