import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";
import * as DriveInflate from "./DriveInflate.ts";

const CheckpointJson = Schema.fromJsonString(DriveInflate.InflateCheckpoint);
const encodeCheckpoint = Schema.encodeEffect(CheckpointJson);
const decodeCheckpoint = Schema.decodeUnknownEffect(CheckpointJson);
const decodeColdResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.String,
      checkpoint: Schema.Null,
      done: Schema.Literal(true),
      consumed: Schema.Number,
      sourceOffset: Schema.Number,
      expandedOffset: Schema.Number,
    }),
  ),
);
const noise = (length: number) => {
  let seed = 0x8121089;
  return Buffer.from(
    Array.from({ length }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed & 255;
    }),
  );
};
const small = Buffer.concat([
  Buffer.from("tree 1324\0"),
  Buffer.from("100644 README.md\0"),
  noise(20),
  Buffer.from("100644 src/content-search-file.ts\0"),
  noise(20),
  Buffer.from("0. ".repeat(500)),
  noise(400),
]);
const wrapped = Buffer.concat([
  noise(40000),
  Buffer.from("tree-entry-100644 README.md\0".repeat(4500)),
  noise(1500),
]);

const walk = (
  expected: Buffer,
  compressed: Buffer,
  options: {
    inputLimit?: number;
    outputLimit?: number;
  } = {},
) =>
  Effect.gen(function* () {
    let checkpoint: DriveInflate.InflateCheckpoint | null = null;
    let sourceOffset = 0;
    let expandedOffset = 0;
    let calls = 0;
    let outputOnlyCalls = 0;
    let largestCheckpoint = 0;
    while (calls++ < 10000) {
      const chunkSize = options.inputLimit ?? compressed.length;
      const end = Math.min(sourceOffset + chunkSize, compressed.length);
      const result: Effect.Success<ReturnType<typeof DriveInflate.inflateMetadataStep>> =
        yield* DriveInflate.inflateMetadataStep({
          checkpoint,
          input: compressed.subarray(sourceOffset, end),
          expectedSize: expected.length,
          sourceEnded: end === compressed.length,
          ...(options.inputLimit === undefined ? {} : { inputLimit: options.inputLimit }),
          ...(options.outputLimit === undefined ? {} : { outputLimit: options.outputLimit }),
        });
      expect(result.consumed).toBeLessThanOrEqual(
        options.inputLimit ?? DriveInflate.INFLATE_MAX_BYTES,
      );
      expect(result.output.length).toBeLessThanOrEqual(
        options.outputLimit ?? DriveInflate.INFLATE_MAX_BYTES,
      );
      expect(Buffer.from(result.output)).toEqual(
        expected.subarray(expandedOffset, expandedOffset + result.output.length),
      );
      sourceOffset += result.consumed;
      expandedOffset += result.output.length;
      expect(result.sourceOffset).toBe(sourceOffset);
      expect(result.expandedOffset).toBe(expandedOffset);
      if (result.consumed === 0 && result.output.length > 0) outputOnlyCalls++;
      if (result.done) {
        expect(result.checkpoint).toBeNull();
        expect(sourceOffset).toBe(compressed.length);
        expect(expandedOffset).toBe(expected.length);
        return { calls, outputOnlyCalls, largestCheckpoint };
      }
      expect(result.consumed + result.output.length).toBeGreaterThan(0);
      expect(result.checkpoint).not.toBeNull();
      if (result.checkpoint === null) throw new Error("Missing checkpoint");
      const json: string = yield* encodeCheckpoint(result.checkpoint);
      largestCheckpoint = Math.max(largestCheckpoint, json.length);
      expect(json.length).toBeLessThanOrEqual(DriveInflate.INFLATE_MAX_CHECKPOINT_BYTES);
      checkpoint = yield* decodeCheckpoint(json);
    }
    throw new Error("Inflater did not finish within the fixture's call budget");
  });

describe("DriveInflate", () => {
  it.effect.each([
    {
      name: "stored",
      data: small,
      options: { level: 0 },
      block: 0,
      inputLimit: 1,
      outputLimit: 17,
    },
    {
      name: "fixed",
      data: small,
      options: { strategy: NodeZlib.constants.Z_FIXED },
      block: 1,
      inputLimit: 1,
      outputLimit: 17,
    },
    {
      name: "dynamic",
      data: Buffer.alloc(3000, 120),
      options: { level: 9 },
      block: 2,
      inputLimit: 1,
      outputLimit: 17,
    },
    {
      name: "one-byte output",
      data: small.subarray(0, 64),
      options: { level: 0 },
      block: 0,
      inputLimit: 1,
      outputLimit: 1,
    },
  ])("restarts $name blocks through split headers, tables, and trailers", (fixture) =>
    Effect.gen(function* () {
      const compressed = NodeZlib.deflateSync(fixture.data, fixture.options);
      expect((compressed[2]! >> 1) & 3).toBe(fixture.block);
      yield* walk(fixture.data, compressed, fixture);
    }),
  );

  it.effect("restores the rolling dictionary after wrap and through the fast path", () =>
    Effect.gen(function* () {
      const compressed = NodeZlib.deflateSync(wrapped);
      yield* walk(wrapped, compressed, { inputLimit: 1024, outputLimit: 1024 });
    }),
  );

  it.effect("caps input when the caller hands over the whole stored stream", () =>
    Effect.gen(function* () {
      const data = noise(2 * DriveInflate.INFLATE_MAX_BYTES + 101);
      const result = yield* walk(data, NodeZlib.deflateSync(data, { level: 0 }));
      expect(result.calls).toBeGreaterThan(2);
    }),
  );

  it.effect("caps highly compressed output and resumes without consuming input", () =>
    Effect.gen(function* () {
      const data = Buffer.alloc(3 * DriveInflate.INFLATE_MAX_BYTES + 17, 120);
      const compressed = NodeZlib.deflateSync(data, { level: 9 });
      expect(compressed.length).toBeLessThan(1024);
      const result = yield* walk(data, compressed, { inputLimit: 1, outputLimit: 257 });
      expect(result.outputOnlyCalls).toBeGreaterThan(100);
      const defaultBudget = yield* walk(data, compressed);
      expect(defaultBudget.calls).toBe(4);
    }),
  );

  it.effect.each(["fixed", "dynamic"] as const)("restores %s state in a new process", (kind) =>
    Effect.gen(function* () {
      const data =
        kind === "fixed"
          ? Buffer.from("fixed-table-cold-restart".repeat(20))
          : Buffer.alloc(3000, 120);
      const compressed = NodeZlib.deflateSync(
        data,
        kind === "fixed" ? { strategy: NodeZlib.constants.Z_FIXED } : { level: 9 },
      );
      const first = yield* DriveInflate.inflateMetadataStep({
        checkpoint: null,
        input: compressed,
        expectedSize: data.length,
        sourceEnded: true,
        outputLimit: 17,
      });
      if (first.checkpoint === null) throw new Error("Missing restart fixture checkpoint");
      const checkpoint = yield* decodeCheckpoint(yield* encodeCheckpoint(first.checkpoint));
      const script = `
      import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
      import { inflateMetadataStep } from ${JSON.stringify(new URL("./DriveInflate.ts", import.meta.url).href)};
      let json = "";
      for await (const chunk of process.stdin) json += chunk;
      const request = JSON.parse(json);
      const result = await Effect.runPromise(inflateMetadataStep({ ...request, input: Buffer.from(request.input, "base64") }));
      process.stdout.write(JSON.stringify({ ...result, output: Buffer.from(result.output).toString("base64") }));
    `;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(NodeProcess.execPath, ["--input-type=module", "--eval", script], {
          stdin: Stream.succeed(
            Buffer.from(
              JSON.stringify({
                checkpoint,
                input: compressed.subarray(first.sourceOffset).toString("base64"),
                expectedSize: data.length,
                sourceEnded: true,
              }),
            ),
          ),
          stderr: "inherit",
        }),
      );
      const [json, code] = yield* Effect.all(
        [Stream.mkString(child.stdout.pipe(Stream.decodeText())), child.exitCode],
        { concurrency: 2 },
      );
      expect(Number(code)).toBe(0);
      const result = yield* decodeColdResponse(json);
      expect(Buffer.from(first.output)).toEqual(data.subarray(0, 17));
      expect(Buffer.from(result.output, "base64")).toEqual(data.subarray(17));
      expect(first.consumed + result.consumed).toBe(compressed.length);
      expect(result.sourceOffset).toBe(compressed.length);
      expect(result.expandedOffset).toBe(data.length);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes an empty zlib stream only after its trailer", () =>
    walk(Buffer.alloc(0), NodeZlib.deflateSync(Buffer.alloc(0)), { inputLimit: 1, outputLimit: 1 }),
  );

  it.effect("leaves subsequent pack bytes unconsumed", () =>
    Effect.gen(function* () {
      const compressed = NodeZlib.deflateSync(small);
      const result = yield* DriveInflate.inflateMetadataStep({
        checkpoint: null,
        input: Buffer.concat([compressed, NodeZlib.deflateSync(Buffer.from("next pack entry"))]),
        expectedSize: small.length,
        sourceEnded: true,
      });
      expect(result.done).toBe(true);
      expect(result.consumed).toBe(compressed.length);
      expect(result.sourceOffset).toBe(compressed.length);
      expect(Buffer.from(result.output)).toEqual(small);
    }),
  );

  it.effect("waits for more input without inventing progress and can replay a checkpoint", () =>
    Effect.gen(function* () {
      const compressed = NodeZlib.deflateSync(small);
      const first = yield* DriveInflate.inflateMetadataStep({
        checkpoint: null,
        input: compressed.subarray(0, 1),
        expectedSize: small.length,
        sourceEnded: false,
      });
      const idle = yield* DriveInflate.inflateMetadataStep({
        checkpoint: first.checkpoint,
        input: new Uint8Array(),
        expectedSize: small.length,
        sourceEnded: false,
      });
      expect(idle.consumed).toBe(0);
      expect(idle.output.length).toBe(0);
      expect(idle.done).toBe(false);
      const input = {
        checkpoint: first.checkpoint,
        input: compressed.subarray(1),
        expectedSize: small.length,
        sourceEnded: true,
      };
      const before = JSON.stringify(first.checkpoint);
      const a = yield* DriveInflate.inflateMetadataStep(input);
      const b = yield* DriveInflate.inflateMetadataStep(input);
      expect(a).toEqual(b);
      expect(JSON.stringify(first.checkpoint)).toBe(before);
      expect(a.done).toBe(true);
    }),
  );

  it.effect.each([0, 1, 2, 3, 4])(
    "rejects truncated EOF with %i missing trailer bytes",
    (missing) =>
      Effect.gen(function* () {
        const compressed = NodeZlib.deflateSync(small);
        const input = missing === 0 ? compressed.subarray(0, 1) : compressed.subarray(0, -missing);
        const error = yield* Effect.flip(
          DriveInflate.inflateMetadataStep({
            checkpoint: null,
            input,
            expectedSize: small.length,
            sourceEnded: true,
          }),
        );
        expect(error.reason).toBe("truncated-input");
      }),
  );

  it.effect.each(["header", "block", "checksum", "preset-dictionary"] as const)(
    "rejects corrupt or unsupported %s",
    (part) =>
      Effect.gen(function* () {
        const compressed = NodeZlib.deflateSync(small);
        if (part === "header") compressed[0] = 0;
        if (part === "block") compressed[2] = 7;
        if (part === "checksum") compressed[compressed.length - 1]! ^= 1;
        const input =
          part === "preset-dictionary"
            ? NodeZlib.deflateSync(small, { dictionary: small })
            : compressed;
        const error = yield* Effect.flip(
          DriveInflate.inflateMetadataStep({
            checkpoint: null,
            input,
            expectedSize: small.length,
            sourceEnded: true,
          }),
        );
        expect(error.reason).toBe("corrupt-stream");
      }),
  );

  it.effect.each([-1, 1])("rejects an expanded size mismatch of %i", (delta) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        DriveInflate.inflateMetadataStep({
          checkpoint: null,
          input: NodeZlib.deflateSync(small),
          expectedSize: small.length + delta,
          sourceEnded: true,
        }),
      );
      expect(error.reason).toBe(delta < 0 ? "oversize-result" : "size-mismatch");
    }),
  );

  it.effect.each([0, -1, 65537, 1.5, NaN])("rejects invalid budget %s", (outputLimit) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        DriveInflate.inflateMetadataStep({
          checkpoint: null,
          input: new Uint8Array(),
          expectedSize: 0,
          sourceEnded: false,
          outputLimit,
        }),
      );
      expect(error.reason).toBe("invalid-input");
    }),
  );

  it.effect.each([
    "version",
    "scalar",
    "extra-field",
    "array-size",
    "array-type",
    "alias",
    "offset",
    "expected-size",
  ])("rejects invalid checkpoint %s", (fault) =>
    Effect.gen(function* () {
      const first = yield* DriveInflate.inflateMetadataStep({
        checkpoint: null,
        input: NodeZlib.deflateSync(small).subarray(0, 1),
        expectedSize: small.length,
        sourceEnded: false,
      });
      if (first.checkpoint === null) throw new Error("Missing fixture checkpoint");
      const cp = first.checkpoint;
      const bad =
        fault === "version"
          ? { ...cp, format: "pako-3" }
          : fault === "scalar"
            ? { ...cp, state: { ...cp.state, bits: 1000000 } }
            : fault === "extra-field"
              ? { ...cp, state: { ...cp.state, input: [] } }
              : fault === "array-size"
                ? {
                    ...cp,
                    arrays: cp.arrays.map((array) =>
                      array === null ? null : { ...array, data: "A".repeat(50000) },
                    ),
                  }
                : fault === "array-type"
                  ? {
                      ...cp,
                      arrays: cp.arrays.map((array) =>
                        array === null ? null : { ...array, type: "object" },
                      ),
                    }
                  : fault === "alias"
                    ? { ...cp, refs: { ...cp.refs, lens: cp.refs.work } }
                    : fault === "offset"
                      ? { ...cp, expandedOffset: 1 }
                      : { ...cp, expectedSize: cp.expectedSize + 1 };
      const error = yield* Effect.flip(
        DriveInflate.inflateMetadataStep({
          checkpoint: bad,
          input: new Uint8Array(),
          expectedSize: small.length,
          sourceEnded: false,
        }),
      );
      expect(error.reason).toBe("invalid-checkpoint");
    }),
  );

  it.effect.each(["zero-bit-match", "subtable", "code-length"])(
    "rejects unsafe checkpoint %s before calling Pako",
    (fault) =>
      Effect.gen(function* () {
        const first = yield* DriveInflate.inflateMetadataStep({
          checkpoint: null,
          input: NodeZlib.deflateSync(Buffer.alloc(3000, 120)),
          expectedSize: 3000,
          sourceEnded: true,
          outputLimit: 17,
        });
        if (first.checkpoint === null) throw new Error("Missing table fixture checkpoint");
        const cp = first.checkpoint;
        const reference = fault === "code-length" ? cp.refs.lens : cp.refs.lencode;
        const arrays = cp.arrays.map((array, index) => {
          if (array === null || index !== reference) return array;
          const bytes = Buffer.from(array.data, "base64");
          if (fault === "code-length") bytes.writeUInt16LE(65535, 0);
          else
            bytes.writeInt32LE(fault === "subtable" ? (1 << 24) | (1 << 16) | 65535 : 16 << 16, 0);
          return { ...array, data: bytes.toString("base64") };
        });
        const error = yield* Effect.flip(
          DriveInflate.inflateMetadataStep({
            checkpoint: { ...cp, arrays, state: { ...cp.state, mode: 16200, bits: 0, hold: 0 } },
            input: new Uint8Array(),
            expectedSize: 3000,
            sourceEnded: false,
          }),
        );
        expect(error.reason).toBe("invalid-checkpoint");
      }),
  );

  it.effect.each([16201, 16202, 16203, 16204])(
    "rejects a zero-length pending match in mode %i",
    (mode) =>
      Effect.gen(function* () {
        const first = yield* DriveInflate.inflateMetadataStep({
          checkpoint: null,
          input: NodeZlib.deflateSync(Buffer.alloc(3000, 120)),
          expectedSize: 3000,
          sourceEnded: true,
          outputLimit: 17,
        });
        if (first.checkpoint === null) throw new Error("Missing match fixture checkpoint");
        const cp = first.checkpoint;
        const error = yield* Effect.flip(
          DriveInflate.inflateMetadataStep({
            checkpoint: { ...cp, state: { ...cp.state, mode, length: 0, offset: 1 } },
            input: new Uint8Array(),
            expectedSize: 3000,
            sourceEnded: false,
          }),
        );
        expect(error.reason).toBe("invalid-checkpoint");
      }),
  );

  it.effect("preserves the immediate thrown cause", () =>
    Effect.gen(function* () {
      const cause = new Error("fixture read failed");
      const input = new Uint8Array();
      input.subarray = () => {
        throw cause;
      };
      const error = yield* Effect.flip(
        DriveInflate.inflateMetadataStep({
          checkpoint: null,
          input,
          expectedSize: 0,
          sourceEnded: false,
        }),
      );
      expect(error.cause).toBe(cause);
    }),
  );
});
