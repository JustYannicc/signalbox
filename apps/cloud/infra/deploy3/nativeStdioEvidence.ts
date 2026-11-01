import * as Schema from "effect/Schema";
import {
  digestLocalEvidenceChunks,
  hashLocalEvidenceFile,
  readLocalEvidenceChunks,
  writeLocalEvidenceChunks,
} from "./localEvidenceFiles.ts";
import { NATIVE_STDIO_CHANNELS } from "./nativeStdio.ts";
import { inspectNativeStdio, type InspectedNativeStdioStream } from "./nativeStdioJournal.ts";

const NativeStdioEvidenceRef = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
});
export const NativeStdioEvidence = Schema.Struct({
  incarnation: Schema.String,
  channel: Schema.Literals(NATIVE_STDIO_CHANNELS),
  evidenceRef: NativeStdioEvidenceRef,
  complete: Schema.Boolean,
  observedBytes: Schema.NullOr(Schema.Number),
  chunkCount: Schema.Number,
  legacy: Schema.Literals(["none", "prefix", "raw-without-summary"]),
  incompleteReason: Schema.NullOr(Schema.String),
});
export type NativeStdioEvidence = typeof NativeStdioEvidence.Type;

export async function inspectLegacyLocalStdio(input: {
  readonly entries: unknown;
  readonly readBlob: (id: string) => Promise<Uint8Array>;
}) {
  const streams = await inspectNativeStdio(input);
  if (streams.some((stream) => stream.legacy === "prefix" && !stream.complete))
    return "legacy-v1-prefix-incomplete-unassembled" as const;
  if (streams.some((stream) => !stream.complete))
    return "legacy-v1-stdio-incomplete-unassembled" as const;
  return streams.length > 0
    ? ("legacy-v1-stdio-unassembled" as const)
    : ("legacy-v1-has-no-assembled-stdio" as const);
}

function expectedPaths(streams: readonly InspectedNativeStdioStream[]) {
  const counts = new Map<(typeof NATIVE_STDIO_CHANNELS)[number], number>();
  for (const stream of streams) counts.set(stream.channel, (counts.get(stream.channel) ?? 0) + 1);
  const indexes = new Map<(typeof NATIVE_STDIO_CHANNELS)[number], number>();
  return streams.map((stream) => {
    const index = (indexes.get(stream.channel) ?? 0) + 1;
    indexes.set(stream.channel, index);
    return counts.get(stream.channel) === 1
      ? `${stream.channel}.bin`
      : `${stream.channel}-${String(index).padStart(3, "0")}.bin`;
  });
}

function fail(message: string): never {
  throw new Error(message);
}

export async function exportNativeStdioEvidence(input: {
  readonly directory: string;
  readonly entries: unknown;
  readonly blobFiles: ReadonlyMap<string, string>;
  readonly readBlob: (id: string) => Promise<Uint8Array>;
}) {
  const streams = await inspectNativeStdio(input);
  const paths = expectedPaths(streams);
  const output: NativeStdioEvidence[] = [];
  for (const [index, stream] of streams.entries()) {
    const fileChunks = async function* () {
      for (const chunk of stream.chunks) {
        const blobFile = input.blobFiles.get(chunk.ref.id);
        if (!blobFile) fail("Native stdio chunk has no local blob file");
        yield* readLocalEvidenceChunks(input.directory, blobFile);
      }
    };
    const file = await writeLocalEvidenceChunks(input.directory, paths[index]!, fileChunks());
    if (file.bytes !== stream.capturedBytes) fail("Assembled native stdio byte count differs");
    output.push({
      incarnation: stream.incarnation,
      channel: stream.channel,
      evidenceRef: { path: file.name, sha256: file.sha256, bytes: file.bytes },
      complete: stream.complete,
      observedBytes: stream.observedBytes,
      chunkCount: stream.chunkCount,
      legacy: stream.legacy,
      incompleteReason: stream.incompleteReason,
    });
  }
  return output;
}

export async function verifyNativeStdioEvidence(input: {
  readonly directory: string;
  readonly entries: unknown;
  readonly blobFiles: ReadonlyMap<string, string>;
  readonly readBlob: (id: string) => Promise<Uint8Array>;
  readonly evidence: readonly NativeStdioEvidence[];
  readonly allowIncomplete?: boolean;
}) {
  const streams = await inspectNativeStdio(input);
  const paths = expectedPaths(streams);
  if (streams.length !== input.evidence.length) fail("Local export omitted native stdio streams");
  for (const [index, stream] of streams.entries()) {
    const evidence = input.evidence[index];
    const expectedPath = paths[index]!;
    if (
      !evidence ||
      evidence.incarnation !== stream.incarnation ||
      evidence.channel !== stream.channel ||
      evidence.complete !== stream.complete ||
      evidence.observedBytes !== stream.observedBytes ||
      evidence.chunkCount !== stream.chunkCount ||
      evidence.legacy !== stream.legacy ||
      evidence.incompleteReason !== stream.incompleteReason ||
      evidence.evidenceRef.path !== expectedPath ||
      evidence.evidenceRef.bytes !== stream.capturedBytes ||
      !/^[a-f0-9]{64}$/.test(evidence.evidenceRef.sha256)
    ) {
      fail("Local native stdio reference differs from its journal");
    }
    const chunkFiles = stream.chunks.map((chunk) => {
      const name = input.blobFiles.get(chunk.ref.id);
      if (!name) fail("Native stdio chunk has no local blob file");
      return name;
    });
    const expected = await digestLocalEvidenceChunks(input.directory, chunkFiles);
    const actual = await hashLocalEvidenceFile(input.directory, expectedPath);
    if (
      expected.bytes !== stream.capturedBytes ||
      expected.bytes !== evidence.evidenceRef.bytes ||
      expected.sha256 !== evidence.evidenceRef.sha256 ||
      actual.bytes !== evidence.evidenceRef.bytes ||
      actual.sha256 !== evidence.evidenceRef.sha256
    ) {
      fail("Local native stdio stream differs from its persisted chunks");
    }
    if (!stream.complete && input.allowIncomplete !== true)
      fail("Local native stdio stream is explicitly incomplete");
  }
  return input.evidence;
}
