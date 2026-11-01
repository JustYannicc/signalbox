import { expect, it } from "vite-plus/test";
import { createNativeStdioCapture, type NativeStdioChannel } from "./nativeStdio.ts";

const CHUNK_BYTES = 32_768;

it("copies and publishes complete stdio streams past the former 16 KiB limit", () => {
  const capture = createNativeStdioCapture();
  const streams = new Map<NativeStdioChannel, Uint8Array[]>();
  const enqueue = (channel: NativeStdioChannel, bytes: Uint8Array) => {
    streams.set(channel, [...(streams.get(channel) ?? []), bytes]);
    return true;
  };
  const stdout = Uint8Array.from({ length: 90_000 }, (_, index) => index % 251);
  const stderr = Uint8Array.from({ length: 37_111 }, (_, index) => (index * 7) % 256);
  const stdin = Uint8Array.from({ length: 20_001 }, (_, index) => (index * 13) % 256);
  const expected = new Map([
    ["native-stdout", stdout.slice()],
    ["native-stderr", stderr.slice()],
    ["native-stdin", stdin.slice()],
  ] as const);

  capture.write("native-stdout", stdout.subarray(0, 7_000), enqueue);
  capture.write("native-stderr", stderr, enqueue);
  capture.write("native-stdin", stdin, enqueue);
  capture.write("native-stdout", stdout.subarray(7_000), enqueue);
  stdout.fill(42);
  stderr.fill(42);
  stdin.fill(42);

  const summary = capture.drain();
  for (const [channel, bytes] of expected) {
    const chunks = streams.get(channel) ?? [];
    const actual = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(actual).toEqual(bytes);
    expect(summary.streams[channel].observedBytes).toBe(bytes.byteLength);
    expect(summary.streams[channel].acceptedBytes).toBe(bytes.byteLength);
    expect(summary.streams[channel].chunkCount).toBe(chunks.length);
    expect(chunks.every((chunk) => chunk.byteLength <= CHUNK_BYTES)).toBe(true);
    expect(summary.streams[channel].complete).toBe(true);
  }

  const priorCount = [...streams.values()].reduce((sum, chunks) => sum + chunks.length, 0);
  capture.drain();
  expect([...streams.values()].reduce((sum, chunks) => sum + chunks.length, 0)).toBe(priorCount);
});

it("publishes every write immediately and does not repeat chunks on drains", () => {
  const capture = createNativeStdioCapture();
  const chunks: Uint8Array[] = [];
  const enqueue = (_channel: NativeStdioChannel, bytes: Uint8Array) => {
    chunks.push(bytes);
    return true;
  };

  capture.write("native-stdout", new Uint8Array([1, 2, 3]), enqueue);
  capture.drain();
  capture.write("native-stdout", new Uint8Array([4, 5]), enqueue);
  const summary = capture.drain();

  expect(chunks).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  expect(summary.streams["native-stdout"]).toMatchObject({
    observedBytes: 5,
    acceptedBytes: 5,
    chunkCount: 2,
    complete: true,
  });
});

it("marks queue refusal as incomplete instead of silently dropping the stream tail", () => {
  const capture = createNativeStdioCapture();
  const accepted: Uint8Array[] = [];
  let attempts = 0;
  const enqueue = (_channel: NativeStdioChannel, bytes: Uint8Array) => {
    attempts += 1;
    if (attempts > 1) return false;
    accepted.push(bytes);
    return true;
  };
  capture.write("native-stderr", new Uint8Array(CHUNK_BYTES * 2 + 3), enqueue);

  const summary = capture.drain();
  expect(accepted).toHaveLength(1);
  expect(summary.streams["native-stderr"]).toMatchObject({
    observedBytes: CHUNK_BYTES * 2 + 3,
    acceptedBytes: CHUNK_BYTES,
    chunkCount: 1,
    complete: false,
    incompleteReason: "capture-sink-rejected",
  });
});
