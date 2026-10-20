import * as NodeReadline from "node:readline";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Compare native Node stream behavior with the compatibility facade.
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeReadline } from "../NodeReadline.ts";
import { createNodeBridge, createNodeBridgeLayerModules } from "../NodeBridge.ts";

const readline = createNodeReadline();

async function collect(input: AsyncIterable<string>) {
  const lines = [];
  for await (const line of input) lines.push(line);
  return lines;
}

async function framed(
  module: Pick<typeof readline, "createInterface"> | typeof NodeReadline,
  chunks: (string | Uint8Array)[],
) {
  const input = new NodeStream.PassThrough();
  const reader = module.createInterface({ input, terminal: false, crlfDelay: Infinity });
  const result = collect(reader);
  for (const chunk of chunks) input.write(chunk);
  input.end();
  return result;
}

describe("non-terminal readline", () => {
  it.each([
    ["burst", ["one\r\ntwo\n\nthree\rfour"]],
    ["split CRLF", ["one\r", "\ntwo\r", "three\n", "\r", "\nfour\n"]],
    ["empty input", []],
    ["empty lines", ["\r", "\n\n\r", "\n"]],
    ["final CR", ["tail\r"]],
    ["Unicode separators", ["one\u2028two\u2029three\n"]],
    ["split text", ["pa", "rt\nfi", "nal"]],
    ["split UTF-8", [...Buffer.from("é🙂\r\n日本語\n末")].map((byte) => Uint8Array.of(byte))],
  ] as const)("matches native Node for %s", async (_name, chunks) => {
    const values = [...chunks];
    expect(await framed(readline, values)).toEqual(await framed(NodeReadline, values));
  });

  it("matches Node at EOF with incomplete UTF-8 and preserves the BOM", async () => {
    const chunks = [Uint8Array.of(0xef, 0xbb, 0xbf), "head\n", Uint8Array.of(0xe2, 0x82)];
    expect(await framed(readline, chunks)).toEqual(await framed(NodeReadline, chunks));
    expect(await framed(readline, chunks)).toEqual(["\ufeffhead"]);
  });

  it("honors CRLF delay across chunks without waiting on a timer", async () => {
    const clock = vi.spyOn(performance, "now");
    try {
      for (const delay of [undefined, Infinity]) {
        const input = new NodeStream.PassThrough();
        const reader = readline.createInterface({ input, crlfDelay: delay });
        const result = collect(reader);
        clock.mockReturnValue(0);
        input.write("first\r");
        clock.mockReturnValue(200);
        input.end("\nsecond");
        expect(await result).toEqual(
          delay === Infinity ? ["first", "second"] : ["first", "", "second"],
        );
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("emits lines before close and detaches every input listener without destroying it", async () => {
    const input = new NodeStream.PassThrough();
    const original = ["data", "end", "error"].map((event) => input.listenerCount(event));
    const reader = readline.createInterface(input);
    const events: string[] = [];
    reader.on("line", (line: string) => events.push(line));
    reader.on("close", () => events.push("close"));
    const closed = new Promise<void>((resolve) => reader.once("close", resolve));
    input.end("first\nlast");
    await closed;
    expect(events).toEqual(["first", "last", "close"]);
    expect(["data", "end", "error"].map((event) => input.listenerCount(event))).toEqual(original);
    expect(reader.closed).toBe(true);
    reader.close();
    expect(events).toEqual(["first", "last", "close"]);
  });

  it("break closes the iterator, removes its listeners and leaves borrowed input alive", async () => {
    const input = new NodeStream.PassThrough();
    const reader = readline.createInterface({ input });
    const read = (async () => {
      for await (const line of reader) {
        expect(line).toBe("first");
        break;
      }
    })();
    input.write("first\nsecond\n");
    await read;
    expect(reader.closed).toBe(true);
    expect(input.destroyed).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(["data", "end", "error"].map((event) => input.listenerCount(event))).toEqual([0, 0, 0]);
    expect(["line", "close", "error"].map((event) => reader.listenerCount(event))).toEqual([
      0, 0, 0,
    ]);
    input.destroy();
  });

  it("end drains all queued lines, including concurrent pending iterator reads", async () => {
    const input = new NodeStream.PassThrough();
    const reader = readline.createInterface({ input });
    const iterator = reader[Symbol.asyncIterator]();
    expect(reader[Symbol.asyncIterator]()).toBe(iterator);
    const first = iterator.next();
    const second = iterator.next();
    input.end("first\nsecond\nthird");
    expect(await first).toEqual({ value: "first", done: false });
    expect(await second).toEqual({ value: "second", done: false });
    expect(await iterator.next()).toEqual({ value: "third", done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("abort settles a pending iterator and detaches its input", async () => {
    const input = new NodeStream.PassThrough();
    const abort = new AbortController();
    const reader = readline.createInterface({ input, signal: abort.signal });
    const pending = reader[Symbol.asyncIterator]().next();
    abort.abort();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  it("input failures reject pending iteration and clean up listeners", async () => {
    const input = new NodeStream.PassThrough();
    const reader = readline.createInterface({ input });
    const pending = reader[Symbol.asyncIterator]().next();
    const failure = new Error("input failed");
    input.emit("error", failure);
    await expect(pending).rejects.toBe(failure);
    expect(reader.closed).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  it("pauses and resumes input when queued iteration exceeds its water mark", async () => {
    const input = NodeStream.Readable.from(
      Array.from({ length: 1200 }, (_, index) => `${index}\n`),
    );
    const reader = readline.createInterface({ input });
    const pause = vi.fn();
    reader.on("pause", pause);
    const paused = new Promise<void>((resolve) => reader.once("pause", resolve));
    const iterator = reader[Symbol.asyncIterator]();
    await paused;
    const result = await collect(iterator);
    expect(result).toEqual(Array.from({ length: 1200 }, (_, index) => String(index)));
    expect(pause).toHaveBeenCalled();
  });

  it("rejects terminal operations instead of exposing silent stubs", () => {
    const input = new NodeStream.PassThrough();
    expect(() => readline.createInterface({ input, terminal: true })).toThrow(
      expect.objectContaining({ code: "ERR_METHOD_NOT_IMPLEMENTED" }),
    );
    const reader = readline.createInterface({ input });
    expect(reader.terminal).toBe(false);
    for (const call of [
      () => reader.question("prompt", () => {}),
      () => reader.prompt(),
      () => readline.cursorTo({}, 0),
      () => readline.emitKeypressEvents(input),
    ])
      expect(call).toThrow(expect.objectContaining({ code: "ERR_METHOD_NOT_IMPLEMENTED" }));
    reader.close();
    input.destroy();
  });

  it("write feeds strings and byte chunks through the same framer as input", async () => {
    async function injected(
      module: Pick<typeof readline, "createInterface"> | typeof NodeReadline,
    ) {
      const input = new NodeStream.PassThrough();
      const reader = module.createInterface({ input, terminal: false, crlfDelay: Infinity });
      const result = collect(reader);
      try {
        input.write("prefix");
        reader.write("-first\r");
        input.write("\n");
        const bytes = Buffer.from("é🙂\r\nlast");
        for (let index = 0; index < bytes.length; index++) {
          const chunk = Uint8Array.of(bytes[index]!);
          if (index % 2 === 0) Reflect.apply(reader.write, reader, [chunk]);
          else input.write(chunk);
        }
        input.end();
        return await result;
      } finally {
        reader.close();
        input.destroy();
      }
    }
    expect(await injected(readline)).toEqual(await injected(NodeReadline));
    expect(await injected(readline)).toEqual(["prefix-first", "é🙂", "last"]);
  });

  it("write resumes paused input before delivering injected lines, matching Node", () => {
    for (const module of [NodeReadline, readline]) {
      const input = new NodeStream.PassThrough();
      const reader = module.createInterface({ input, terminal: false });
      const events: string[] = [];
      reader.on("resume", () => events.push("resume"));
      reader.on("line", (line: string) => events.push(line));
      try {
        reader.pause();
        expect(input.isPaused()).toBe(true);
        expect(reader.write("injected\n")).toBeUndefined();
        expect(input.isPaused()).toBe(false);
        expect(events).toEqual(["resume", "injected"]);
        expect(Reflect.apply(reader.write, reader, [undefined])).toBeUndefined();
        reader.write("data-with-key\n", { name: "return" });
        expect(events).toEqual(["resume", "injected", "data-with-key"]);
      } finally {
        reader.close();
        input.destroy();
      }
    }
  });

  it("write rejects closed state before resuming or accepting data, matching Node", () => {
    for (const module of [NodeReadline, readline]) {
      const input = new NodeStream.PassThrough();
      const reader = module.createInterface({ input, terminal: false });
      reader.close();
      const resume = vi.fn();
      const line = vi.fn();
      reader.on("resume", resume);
      reader.on("line", line);
      try {
        for (const data of ["after\n", Uint8Array.of(10), undefined])
          expect(() => Reflect.apply(reader.write, reader, [data])).toThrow(
            expect.objectContaining({ code: "ERR_USE_AFTER_CLOSE" }),
          );
        expect(resume).not.toHaveBeenCalled();
        expect(line).not.toHaveBeenCalled();
        expect(input.isPaused()).toBe(true);
      } finally {
        input.destroy();
      }
    }
  });

  it("write rejects key-only input explicitly and leaves the framer usable", () => {
    const input = new NodeStream.PassThrough();
    const reader = readline.createInterface({ input });
    const lines: string[] = [];
    reader.on("line", (line: string) => lines.push(line));
    try {
      for (const data of [undefined, null])
        expect(() => reader.write(data, { name: "return" })).toThrow(
          expect.objectContaining({ code: "ERR_METHOD_NOT_IMPLEMENTED" }),
        );
      reader.write("still-open\n");
      expect(lines).toEqual(["still-open"]);
    } finally {
      reader.close();
      input.destroy();
    }
  });

  it("preserves custom module identity across both builtin facade aliases", () => {
    const bridge = createNodeBridge({ readline });
    expect(bridge.require("node:readline")).toBe(readline);
    expect(bridge.require("readline")).toBe(readline);
    expect(readline.default).toBe(readline);
    const facades = createNodeBridgeLayerModules(["readline"]);
    expect(facades.readline).toBe(facades["node:readline"]);
  });
});
