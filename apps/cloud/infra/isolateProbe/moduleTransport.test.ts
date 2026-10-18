import { describe, expect, it } from "@effect/vitest";
import {
  decodeModuleTransport,
  encodeModuleTransport,
  type ModuleDescriptor,
} from "./moduleTransport.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const descriptor = (name: string, type = "text", byteLength = 0) => ({ name, type, byteLength });
const metadata = (modules: unknown[] = []) => ({ input: { id: "opaque" }, modules });

function frame(value: unknown, ...bodies: Uint8Array[]) {
  const json = utf8(JSON.stringify(value));
  const bytes = new Uint8Array(
    4 + json.length + bodies.reduce((sum, body) => sum + body.length, 0),
  );
  new DataView(bytes.buffer).setUint32(0, json.length, false);
  bytes.set(json, 4);
  let offset = 4 + json.length;
  for (const body of bodies) {
    bytes.set(body, offset);
    offset += body.length;
  }
  return bytes;
}

function streamOf(...chunks: Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

function split(bytes: Uint8Array, width: number) {
  const chunks = [];
  for (let index = 0; index < bytes.length; index += width)
    chunks.push(bytes.subarray(index, index + width));
  return streamOf(new Uint8Array(0), ...chunks, new Uint8Array(0));
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("framed module transport", () => {
  it("emits a big-endian metadata length followed by raw module bodies in order", async () => {
    const input = { id: "run", extra: [null, 7] };
    const binary = new Uint8Array([99, 0, 127, 128, 255, 99]);
    const modules: ModuleDescriptor[] = [
      { name: "main.js", type: "js", bytes: utf8("export {}") },
      { name: "engine.wasm", type: "wasm", bytes: binary.subarray(1, 5) },
    ];
    expect(await collect(encodeModuleTransport(input, modules))).toEqual(
      frame(
        {
          input,
          modules: [descriptor("main.js", "js", 9), descriptor("engine.wasm", "wasm", 4)],
        },
        utf8("export {}"),
        new Uint8Array([0, 127, 128, 255]),
      ),
    );
  });

  it.each([1, 3, 7, 31, 65536])("decodes all types across %i-byte chunks", async (width) => {
    const source = "\uFEFFexport const greeting = 'Grüezi 🌍';\r\n";
    const cjs = "module.exports = '日本語';\n";
    const text = "\uFEFFa\u0000b 🐦";
    const binary = new Uint8Array([0, 127, 128, 255]);
    const bodies = [utf8(source), utf8(cjs), utf8(text), binary];
    const names = ["main.js", "common.cjs", "__proto__", "engine.wasm"];
    const types = ["js", "cjs", "text", "wasm"];
    const stream = split(
      frame(
        {
          input: { arbitrary: ["🙂", false], modules: "still opaque" },
          modules: names.map((name, index) =>
            descriptor(name, types[index], bodies[index]!.length),
          ),
        },
        ...bodies,
      ),
      width,
    );
    const result = await decodeModuleTransport(stream);
    expect(result.input).toEqual({ arbitrary: ["🙂", false], modules: "still opaque" });
    expect(Object.keys(result.modules)).toEqual(names);
    expect(result.modules["main.js"]).toEqual({ js: source });
    expect(result.modules["common.cjs"]).toEqual({ cjs });
    expect(Object.getOwnPropertyDescriptor(result.modules, "__proto__")?.value).toEqual({ text });
    expect(result.modules["engine.wasm"]).toEqual({ wasm: binary.buffer });
    expect(stream.locked).toBe(false);
  });

  it("keeps empty modules and opaque JSON input", async () => {
    const types: ModuleDescriptor["type"][] = ["js", "cjs", "text", "wasm"];
    const modules = types.map((type) => ({
      name: type,
      type,
      bytes: new Uint8Array(0),
    }));
    expect(
      await decodeModuleTransport(encodeModuleTransport(null, modules), { maxBodyBytes: 0 }),
    ).toEqual({
      input: null,
      modules: {
        js: { js: "" },
        cjs: { cjs: "" },
        text: { text: "" },
        wasm: { wasm: new ArrayBuffer(0) },
      },
    });
    expect(await decodeModuleTransport(encodeModuleTransport([1, "opaque"], []))).toEqual({
      input: [1, "opaque"],
      modules: {},
    });
  });

  it("round-trips source whose multibyte character crosses the encoder's body chunk boundary", async () => {
    const source = "a".repeat(65535) + "🌍\r\n";
    const binary = new Uint8Array([0, 127, 128, 255]);
    const stream = encodeModuleTransport({ id: "large enough to span chunks" }, [
      { name: "main.js", type: "js", bytes: utf8(source) },
      { name: "engine.wasm", type: "wasm", bytes: binary },
    ]);
    expect((await decodeModuleTransport(stream)).modules).toEqual({
      "main.js": { js: source },
      "engine.wasm": { wasm: binary.buffer },
    });
    expect(stream.locked).toBe(false);
  });

  it("bounds metadata and module chunks to 64 KiB", async () => {
    const input = { label: "x".repeat(70000) };
    const bytes = new Uint8Array(150000).fill(255);
    const stream = encodeModuleTransport(input, [{ name: "engine.wasm", type: "wasm", bytes }]);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        expect(next.value.byteLength).toBeLessThanOrEqual(65536);
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    expect(await decodeModuleTransport(streamOf(...chunks))).toEqual({
      input,
      modules: { "engine.wasm": { wasm: bytes.buffer } },
    });
  });

  it("returns an exact, independent WASM buffer even when source chunks contain adjacent data", async () => {
    const bytes = frame(
      metadata([descriptor("a", "wasm", 4), descriptor("b", "text", 1)]),
      new Uint8Array([0, 127, 128, 255]),
      utf8("x"),
    );
    const result = await decodeModuleTransport(streamOf(bytes));
    bytes.fill(0);
    expect(result.modules).toEqual({
      a: { wasm: new Uint8Array([0, 127, 128, 255]).buffer },
      b: { text: "x" },
    });
  });

  it.each(
    [
      null,
      [],
      {},
      { input: null, modules: {} },
      { modules: [] },
      { input: null, modules: [], extra: true },
      metadata([null]),
      metadata([[]]),
      metadata([{}]),
      metadata([descriptor("")]),
      metadata([{ ...descriptor("a"), name: 4 }]),
      metadata([descriptor("a", "json")]),
      metadata([{ ...descriptor("a"), byteLength: "0" }]),
      metadata([descriptor("a", "js", -1)]),
      metadata([descriptor("a", "js", 0.5)]),
      metadata([descriptor("a", "js", Number.MAX_SAFE_INTEGER + 1)]),
      metadata([descriptor("a", "js", Infinity)]),
      metadata([{ ...descriptor("a"), unexpected: true }]),
    ].map((value) => ({ value })),
  )("rejects malformed metadata %#", async ({ value }) => {
    await expect(decodeModuleTransport(streamOf(frame(value)))).rejects.toThrow(/Invalid module/);
  });

  it("rejects duplicate module names, including prototype property names", async () => {
    for (const name of ["main.js", "__proto__"]) {
      await expect(
        decodeModuleTransport(
          streamOf(frame(metadata([descriptor(name), descriptor(name, "wasm")]))),
        ),
      ).rejects.toThrow("Duplicate module name");
    }
  });

  it.each([0, 1, 2, 3])("rejects a %i-byte length prefix", async (length) => {
    const stream = streamOf(new Uint8Array(length));
    await expect(decodeModuleTransport(stream)).rejects.toThrow("Truncated metadata length");
    expect(stream.locked).toBe(false);
  });

  it("rejects truncated metadata and malformed JSON", async () => {
    const bytes = frame(metadata());
    await expect(
      decodeModuleTransport(streamOf(bytes.subarray(0, bytes.length - 1))),
    ).rejects.toThrow("Truncated metadata");
    bytes[4] = 33;
    await expect(decodeModuleTransport(streamOf(bytes))).rejects.toThrow();
  });

  it.each(["js", "cjs", "text", "wasm"])("rejects truncated %s module bodies", async (type) => {
    await expect(
      decodeModuleTransport(
        streamOf(
          frame(
            metadata([descriptor("first", "text", 1), descriptor("short", type, 2)]),
            utf8("x"),
            new Uint8Array([0]),
          ),
        ),
      ),
    ).rejects.toThrow("Truncated module short");
  });

  it.each([false, true])("rejects trailing bytes in a separate chunk: %s", async (separate) => {
    const bytes = frame(metadata(), new Uint8Array([0]));
    const stream = separate ? streamOf(bytes.subarray(0, -1), bytes.subarray(-1)) : streamOf(bytes);
    await expect(decodeModuleTransport(stream)).rejects.toThrow("Trailing module transport bytes");
  });

  it("rejects invalid UTF-8 in metadata and text rather than changing source", async () => {
    const badMetadata = frame(metadata());
    badMetadata[4] = 255;
    await expect(decodeModuleTransport(streamOf(badMetadata))).rejects.toThrow();
    for (const type of ["js", "cjs", "text"]) {
      for (const bytes of [new Uint8Array([255]), new Uint8Array([0xe2, 0x82])]) {
        await expect(
          decodeModuleTransport(
            split(frame(metadata([descriptor("source", type, bytes.length)]), bytes), 1),
          ),
        ).rejects.toThrow();
      }
    }
  });

  it("checks metadata budgets before reading or allocating the declared payload", async () => {
    const prefix = new Uint8Array([255, 255, 255, 255]);
    await expect(decodeModuleTransport(streamOf(prefix))).rejects.toThrow(
      "Metadata budget exceeded",
    );
    const bytes = frame(metadata());
    const size = bytes.length - 4;
    await expect(
      decodeModuleTransport(streamOf(bytes), { maxMetadataBytes: size - 1 }),
    ).rejects.toThrow("Metadata budget exceeded");
    expect(await decodeModuleTransport(streamOf(bytes), { maxMetadataBytes: size })).toEqual({
      input: { id: "opaque" },
      modules: {},
    });
    const unicodeInput = { unicode: "🌍" };
    const unicodeSize = frame({ input: unicodeInput, modules: [] }).length - 4;
    expect(() =>
      encodeModuleTransport(unicodeInput, [], { maxMetadataBytes: unicodeSize - 1 }),
    ).toThrow("Metadata budget exceeded");
    expect(() => encodeModuleTransport(unicodeInput, [], { maxMetadataBytes: 1 })).toThrow(
      "Metadata budget exceeded",
    );
    expect(() => encodeModuleTransport({}, [], { maxMetadataBytes: 0x100000000 })).toThrow(
      "Invalid metadata budget",
    );
  });

  it("enforces the aggregate body budget before consuming any module", async () => {
    const value = metadata([descriptor("a", "text", 3), descriptor("b", "wasm", 2)]);
    await expect(
      decodeModuleTransport(streamOf(frame(value)), { maxBodyBytes: 4 }),
    ).rejects.toThrow("Module body budget exceeded");
    const modules: ModuleDescriptor[] = [
      { name: "a", type: "text", bytes: utf8("abc") },
      { name: "b", type: "wasm", bytes: new Uint8Array([128, 255]) },
    ];
    expect(() => encodeModuleTransport({}, modules, { maxBodyBytes: 4 })).toThrow(
      "Module body budget exceeded",
    );
    expect(
      (await decodeModuleTransport(encodeModuleTransport({}, modules), { maxBodyBytes: 5 }))
        .modules,
    ).toEqual({ a: { text: "abc" }, b: { wasm: new Uint8Array([128, 255]).buffer } });
  });

  it("allows a 64 MiB plus one declaration by default without allocating a large fixture", async () => {
    await expect(
      decodeModuleTransport(
        streamOf(frame(metadata([descriptor("large.js", "js", 64 * 1024 * 1024 + 1)]))),
      ),
    ).rejects.toThrow("Truncated module large.js");
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid budgets: %s",
    async (value) => {
      expect(() => encodeModuleTransport({}, [], { maxBodyBytes: value })).toThrow(
        "Invalid transport budget",
      );
      const stream = streamOf(frame(metadata()));
      await expect(decodeModuleTransport(stream, { maxMetadataBytes: value })).rejects.toThrow(
        "Invalid transport budget",
      );
      expect(stream.locked).toBe(false);
    },
  );

  it("rejects invalid encoder descriptors and non-JSON input", () => {
    const bytes = new Uint8Array(0);
    expect(() => encodeModuleTransport({}, [{ name: "", type: "js", bytes }])).toThrow(
      "Invalid module descriptor",
    );
    expect(() =>
      encodeModuleTransport({}, [
        { name: "a", type: "js", bytes },
        { name: "a", type: "text", bytes },
      ]),
    ).toThrow("Duplicate module name");
    expect(() => encodeModuleTransport(undefined, [])).toThrow("Invalid module metadata");
    expect(() => encodeModuleTransport(1n, [])).toThrow();
  });

  it("releases malformed streams without aborting their source or replacing the failure", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame(metadata([descriptor("a"), descriptor("a")])));
      },
      cancel() {
        cancellations++;
        throw new Error("cancel failed");
      },
    });
    await expect(decodeModuleTransport(stream)).rejects.toThrow("Duplicate module name");
    expect(cancellations).toBe(0);
    expect(stream.locked).toBe(false);
    await stream.cancel().catch(() => {});
  });

  it("propagates source failures and releases the reader", async () => {
    const failure = new Error("source failed");
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) controller.error(failure);
          else {
            sent = true;
            controller.enqueue(frame(metadata([descriptor("a", "wasm", 4)])));
          }
        },
      },
      { highWaterMark: 0 },
    );
    await expect(decodeModuleTransport(stream)).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });
});
