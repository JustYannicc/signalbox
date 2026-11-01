import { expect, it } from "vite-plus/test";
import { createNativeStdioPrefix, type NativeStdioChannel } from "./nativeOutputPrefix.ts";

it("retains the first 16 KiB of each output stream without decoding or shared memory", () => {
  const output = createNativeStdioPrefix();
  const stdout = Uint8Array.from({ length: 90_000 }, (_, index) => index % 256);
  const stderr = new Uint8Array([255, 0, 128]);
  const expected = stdout.slice(0, 16_384);
  output.write("native-stdout", stdout.subarray(0, 7_000));
  output.write("native-stderr", stderr);
  output.write("native-stdout", stdout.subarray(7_000));
  stdout.fill(42);
  stderr.fill(42);
  const records = new Map<NativeStdioChannel, Uint8Array>();
  const summary = output.drain((channel, bytes) => records.set(channel, bytes));
  expect(records.get("native-stdout")).toEqual(expected);
  expect(records.get("native-stderr")).toEqual(new Uint8Array([255, 0, 128]));
  expect(summary.streams["native-stdin"]).toEqual({
    observation: "consumed",
    observedBytes: 0,
    retainedBytes: 0,
    publishedBytes: 0,
    truncated: false,
  });
  expect(summary.streams["native-stdout"]).toEqual({
    observation: "accepted",
    observedBytes: 90_000,
    retainedBytes: 16_384,
    publishedBytes: 16_384,
    truncated: true,
  });
  expect(summary.streams["native-stderr"]).toEqual({
    observation: "accepted",
    observedBytes: 3,
    retainedBytes: 3,
    publishedBytes: 3,
    truncated: false,
  });
});

it("publishes only new prefix bytes across checkpoint and failure drains", () => {
  const output = createNativeStdioPrefix();
  const records: Uint8Array[] = [];
  output.write("native-stdout", new Uint8Array([1, 2, 3]));
  output.drain((_channel, bytes) => records.push(bytes));
  output.drain((_channel, bytes) => records.push(bytes));
  output.write("native-stdout", new Uint8Array([4, 5]));
  const summary = output.drain((_channel, bytes) => records.push(bytes));
  expect(records).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  expect(summary.streams["native-stdout"].publishedBytes).toBe(5);
  expect(summary.streams["native-stderr"]).toEqual({
    observation: "accepted",
    observedBytes: 0,
    retainedBytes: 0,
    publishedBytes: 0,
    truncated: false,
  });
});

it("caps and incrementally publishes consumed stdin bytes independently of source memory", () => {
  const input = createNativeStdioPrefix();
  const records: Uint8Array[] = [];
  const first = Uint8Array.from({ length: 7_000 }, (_, index) => index % 256);
  const expectedFirst = first.slice();
  input.write("native-stdin", first);
  first.fill(42);

  const firstSummary = input.drain((channel, bytes) => {
    expect(channel).toBe("native-stdin");
    records.push(bytes);
  });
  expect(records).toEqual([expectedFirst]);
  expect(firstSummary.streams["native-stdin"]).toEqual({
    observation: "consumed",
    observedBytes: 7_000,
    retainedBytes: 7_000,
    publishedBytes: 7_000,
    truncated: false,
  });

  const second = Uint8Array.from({ length: 83_000 }, (_, index) => (index + 17) % 256);
  const expectedNext = second.slice(0, 16_384 - expectedFirst.length);
  input.write("native-stdin", second);
  second.fill(99);
  const secondSummary = input.drain((channel, bytes) => {
    expect(channel).toBe("native-stdin");
    records.push(bytes);
  });
  expect(records).toEqual([expectedFirst, expectedNext]);
  expect(secondSummary.streams["native-stdin"]).toEqual({
    observation: "consumed",
    observedBytes: 90_000,
    retainedBytes: 16_384,
    publishedBytes: 16_384,
    truncated: true,
  });

  const repeated = input.drain(() => {
    throw new Error("Published stdin prefix bytes must not be emitted twice");
  });
  expect(repeated.streams["native-stdin"].publishedBytes).toBe(16_384);
});
