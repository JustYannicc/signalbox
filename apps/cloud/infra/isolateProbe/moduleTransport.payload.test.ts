import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  decodeModuleTransport,
  encodeModuleTransport,
  openModuleTransport,
} from "./moduleTransport.ts";

const modules = [
  { name: "main.js", type: "js" as const, bytes: new TextEncoder().encode("export {}") },
];
const payload = new Uint8Array([0, 255, 128, 0xe2, 0x82, 13, 10]);

function frame(value: unknown, ...bodies: Uint8Array[]) {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, json.byteLength, false);
  return new Response(new Blob([prefix, json, ...bodies.map((body) => body.slice().buffer)])).body!;
}

const metadata = (raw: unknown = { byteLength: payload.byteLength }) => ({
  input: { id: "payload", method: "POST" },
  modules: [{ name: "main.js", type: "js", byteLength: modules[0]!.bytes.byteLength }],
  payload: raw,
});

describe("opaque request payload framing", () => {
  it("places opaque bytes after code and preserves the native module inventory", async () => {
    const encoded = new Uint8Array(
      await new Response(encodeModuleTransport({}, modules, {}, payload)).arrayBuffer(),
    );
    expect(encoded.subarray(-payload.byteLength)).toEqual(payload);
    const transport = await openModuleTransport(new Response(encoded).body!);
    expect(transport.moduleNames).toEqual(["main.js"]);
    expect(transport.payloadRange).toEqual({
      offset: encoded.byteLength - payload.byteLength,
      byteLength: payload.byteLength,
    });
    expect(await transport.readModules()).toEqual({ "main.js": { js: "export {}" } });
    await transport.discard();
    const raw = await openModuleTransport(new Response(encoded).body!);
    expect(await raw.readPayload()).toEqual(payload);
    await raw.discard();
  });

  it.each([false, true])("retains only the selected channel, payload %s", async (retainPayload) => {
    const code = new Uint8Array(170001).fill(255);
    const binary = new Uint8Array(70001).fill(128);
    const stream = encodeModuleTransport(
      {},
      [{ name: "code.wasm", type: "wasm", bytes: code }],
      {},
      binary,
    );
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
      if (retainPayload) expect(await transport.readPayload()).toEqual(binary);
      else expect(await transport.readModules()).toEqual({ "code.wasm": { wasm: code.buffer } });
      expect(allocations.includes(code.length)).toBe(!retainPayload);
      expect(allocations.includes(binary.length)).toBe(retainPayload);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes an empty payload from no payload and preserves legacy decode shape", async () => {
    const absent = await openModuleTransport(encodeModuleTransport({}, []));
    expect(absent.payloadRange).toBeUndefined();
    expect(await absent.readPayload()).toBeUndefined();
    const empty = await openModuleTransport(encodeModuleTransport({}, [], {}, new Uint8Array(0)));
    expect(empty.payloadRange?.byteLength).toBe(0);
    expect(await empty.readPayload()).toEqual(new Uint8Array(0));
    expect(await decodeModuleTransport(encodeModuleTransport({}, []))).toEqual({
      input: {},
      modules: {},
    });
  });

  it.each([
    null,
    [],
    {},
    { byteLength: -1 },
    { byteLength: 0.5 },
    { byteLength: "7" },
    { byteLength: Number.MAX_SAFE_INTEGER + 1 },
    { byteLength: 7, type: "wasm" },
  ])("rejects invalid payload metadata %#", async (raw) => {
    await expect(openModuleTransport(frame(metadata(raw)))).rejects.toThrow(
      "Invalid payload descriptor",
    );
  });

  it("charges payload and code against one body budget before reading either body", async () => {
    const total = modules[0]!.bytes.byteLength + payload.byteLength;
    expect(() => encodeModuleTransport({}, modules, { maxBodyBytes: total - 1 }, payload)).toThrow(
      "Payload body budget exceeded",
    );
    await expect(
      openModuleTransport(frame(metadata()), { maxBodyBytes: total - 1 }),
    ).rejects.toThrow("Payload body budget exceeded");
    const valid = await openModuleTransport(
      encodeModuleTransport({}, modules, { maxBodyBytes: total }, payload),
      { maxBodyBytes: total },
    );
    expect(await valid.readPayload()).toEqual(payload);
    // Declaration-only proof checks the default aggregate cap without allocating 128 MiB.
    await expect(
      openModuleTransport(frame(metadata({ byteLength: 128 * 1024 * 1024 }))),
    ).rejects.toThrow("Payload body budget exceeded");
  });

  it("includes payload metadata in the metadata budget", async () => {
    const bytes = new Uint8Array(
      await new Response(encodeModuleTransport({}, [], {}, payload)).arrayBuffer(),
    );
    const length = new DataView(bytes.buffer).getUint32(0, false);
    expect(() => encodeModuleTransport({}, [], { maxMetadataBytes: length - 1 }, payload)).toThrow(
      "Metadata budget exceeded",
    );
    await expect(
      openModuleTransport(new Response(bytes).body!, { maxMetadataBytes: length - 1 }),
    ).rejects.toThrow("Metadata budget exceeded");
  });

  it.each(["readModules", "readPayload", "discard"] as const)(
    "rejects truncation, trailing bytes and bad code through %s",
    async (operation) => {
      for (const [body, error] of [
        [
          frame(metadata(), modules[0]!.bytes, payload.subarray(0, -1)),
          "Truncated request payload",
        ],
        [
          frame(metadata(), modules[0]!.bytes, payload, new Uint8Array([0])),
          "Trailing module transport bytes",
        ],
        [
          frame(
            { ...metadata(), modules: [{ name: "main.js", type: "js", byteLength: 1 }] },
            new Uint8Array([255]),
            payload,
          ),
          /UTF|decode/i,
        ],
      ] as const) {
        const transport = await openModuleTransport(body);
        await expect(transport[operation]()).rejects.toThrow(error);
        await expect(transport.discard()).rejects.toThrow(error);
        expect(body.locked).toBe(false);
      }
    },
  );
});
