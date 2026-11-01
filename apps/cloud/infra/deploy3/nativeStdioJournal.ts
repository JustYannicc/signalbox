import * as Schema from "effect/Schema";
import { EvidenceArtifact } from "./evidenceInventory.ts";
import { NATIVE_STDIO_CHANNELS, type NativeStdioChannel } from "./nativeStdio.ts";

const JournalRecord = Schema.Struct({
  sequence: Schema.Number,
  kind: Schema.String,
  payload: EvidenceArtifact,
});
const RawRecord = Schema.Struct({
  incarnation: Schema.String,
  ordinal: Schema.Number,
  payload: EvidenceArtifact,
});
const CurrentStream = Schema.Struct({
  observation: Schema.Literals(["consumed", "accepted"]),
  observedBytes: Schema.Number,
  acceptedBytes: Schema.Number,
  chunkCount: Schema.Number,
  complete: Schema.Boolean,
  incompleteReason: Schema.NullOr(Schema.String),
});
const CurrentSummary = Schema.Struct({
  schema: Schema.Literal("sb1070/native-stdio-streams/v1"),
  incarnation: Schema.String,
  reason: Schema.String,
  streams: Schema.Struct({
    "native-stdin": CurrentStream,
    "native-stdout": CurrentStream,
    "native-stderr": CurrentStream,
  }),
});
const LegacyStream = Schema.Struct({
  observation: Schema.Literals(["consumed", "accepted"]),
  observedBytes: Schema.Number,
  retainedBytes: Schema.Number,
  publishedBytes: Schema.Number,
  truncated: Schema.Boolean,
});
const LegacySummary = Schema.Struct({
  prefixLimitBytes: Schema.Number,
  incarnation: Schema.String,
  reason: Schema.String,
  streams: Schema.Struct({
    "native-stdin": LegacyStream,
    "native-stdout": LegacyStream,
    "native-stderr": LegacyStream,
  }),
});

const decodeJournalRecord = Schema.decodeUnknownSync(JournalRecord);
const decodeRawRecord = Schema.decodeUnknownSync(RawRecord);
const decodeCurrentSummary = Schema.decodeUnknownSync(CurrentSummary);
const decodeLegacySummary = Schema.decodeUnknownSync(LegacySummary);
const decodeArtifact = Schema.decodeUnknownSync(EvidenceArtifact);
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])),
);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type Artifact = typeof EvidenceArtifact.Type;
type Chunk = { readonly sequence: number; readonly ordinal: number; readonly ref: Artifact };
type LegacyKind = "none" | "prefix" | "raw-without-summary";
export type InspectedNativeStdioStream = {
  readonly incarnation: string;
  readonly channel: NativeStdioChannel;
  readonly complete: boolean;
  readonly observedBytes: number | null;
  readonly chunkCount: number;
  readonly legacy: LegacyKind;
  readonly incompleteReason: string | null;
  readonly capturedBytes: number;
  readonly chunks: readonly Chunk[];
};

function fail(message: string): never {
  throw new Error(message);
}

function assertByteCount(value: number, message: string) {
  if (!Number.isSafeInteger(value) || value < 0) fail(message);
}

function checkedArtifact(value: unknown): Artifact {
  const ref = decodeArtifact(value);
  if (!ref.id || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail("Invalid stdio artifact reference");
  assertByteCount(ref.bytes, "Invalid stdio artifact byte count");
  return ref;
}

function sameArtifact(left: Artifact, right: Artifact) {
  return left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;
}

function groupKey(incarnation: string, channel: NativeStdioChannel) {
  return JSON.stringify([incarnation, channel]);
}

function validateOrdinalSequence(chunks: readonly Chunk[]) {
  let previous = 0;
  for (const chunk of chunks) {
    if (chunk.ordinal !== previous + 1)
      fail("Native stdio journal has a missing or reordered ordinal");
    previous = chunk.ordinal;
  }
}

function observationFor(channel: NativeStdioChannel) {
  return channel === "native-stdin" ? "consumed" : "accepted";
}

async function digest(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function inspectNativeStdio(input: {
  readonly entries: unknown;
  readonly readBlob: (id: string) => Promise<Uint8Array>;
}): Promise<InspectedNativeStdioStream[]> {
  const entries = decodeEntries(input.entries);
  const blobs = new Map<string, Artifact>();
  const records: (typeof JournalRecord.Type)[] = [];
  for (const [key, value] of entries) {
    if (key.startsWith("blob/")) {
      const ref = checkedArtifact(value);
      if (key !== `blob/${ref.id}/ref` || blobs.has(ref.id))
        fail("Native stdio blob identity differs");
      blobs.set(ref.id, ref);
    } else if (key.startsWith("journal/record/")) {
      records.push(decodeJournalRecord(value));
    }
  }

  const readJsonBlob = async (inputRef: Artifact) => {
    const ref = blobs.get(inputRef.id);
    if (!ref || !sameArtifact(ref, inputRef))
      fail("Native stdio journal references a missing blob");
    if (ref.bytes > 1024 * 1024) fail("Native stdio journal record exceeds its bound");
    const bytes = await input.readBlob(ref.id);
    if (bytes.byteLength !== ref.bytes || (await digest(bytes)) !== ref.sha256)
      fail("Native stdio journal record hash differs");
    return JSON.parse(textDecoder.decode(bytes)) as unknown;
  };

  const chunks = new Map<string, Chunk[]>();
  const summaries = new Map<
    string,
    | {
        readonly kind: "current";
        readonly sequence: number;
        readonly value: typeof CurrentSummary.Type;
      }
    | {
        readonly kind: "legacy";
        readonly sequence: number;
        readonly value: typeof LegacySummary.Type;
      }
  >();
  let previousSequence = 0;
  for (const record of records) {
    if (!Number.isSafeInteger(record.sequence) || record.sequence <= previousSequence)
      fail("Native stdio journal records changed order");
    previousSequence = record.sequence;
    if ((NATIVE_STDIO_CHANNELS as readonly string[]).includes(record.kind)) {
      const raw = decodeRawRecord(await readJsonBlob(checkedArtifact(record.payload)));
      if (!raw.incarnation || !Number.isSafeInteger(raw.ordinal) || raw.ordinal <= 0)
        fail("Native stdio chunk identity is invalid");
      const ref = checkedArtifact(raw.payload);
      const blob = blobs.get(ref.id);
      if (!blob || !sameArtifact(blob, ref)) fail("Native stdio chunk blob is missing");
      const key = groupKey(raw.incarnation, record.kind as NativeStdioChannel);
      const group = chunks.get(key) ?? [];
      group.push({ sequence: record.sequence, ordinal: raw.ordinal, ref });
      chunks.set(key, group);
    } else if (record.kind === "native-stdio-streams") {
      const value = decodeCurrentSummary(await readJsonBlob(checkedArtifact(record.payload)));
      if (!value.incarnation) fail("Native stdio capture incarnation is empty");
      summaries.set(value.incarnation, { kind: "current", sequence: record.sequence, value });
    } else if (record.kind === "native-stdio-prefix") {
      const value = decodeLegacySummary(await readJsonBlob(checkedArtifact(record.payload)));
      if (!value.incarnation) fail("Legacy native stdio incarnation is empty");
      summaries.set(value.incarnation, { kind: "legacy", sequence: record.sequence, value });
    }
  }

  for (const group of chunks.values()) validateOrdinalSequence(group);
  const incarnations = new Set<string>([
    ...summaries.keys(),
    ...[...chunks.keys()].map((key) => JSON.parse(key)[0] as string),
  ]);
  const inspected: InspectedNativeStdioStream[] = [];
  for (const incarnation of [...incarnations].sort()) {
    const summary = summaries.get(incarnation);
    const channels = summary
      ? NATIVE_STDIO_CHANNELS
      : NATIVE_STDIO_CHANNELS.filter((channel) => chunks.has(groupKey(incarnation, channel)));
    for (const channel of channels) {
      const streamChunks = chunks.get(groupKey(incarnation, channel)) ?? [];
      const capturedBytes = streamChunks.reduce((sum, chunk) => sum + chunk.ref.bytes, 0);
      assertByteCount(capturedBytes, "Native stdio byte total is invalid");
      let complete = false;
      let observedBytes: number | null = null;
      let legacy: LegacyKind = "raw-without-summary";
      let incompleteReason: string | null = "legacy-stream-total-unavailable";
      if (summary?.kind === "current") {
        const lastRaw = streamChunks.at(-1)?.sequence ?? 0;
        if (lastRaw > summary.sequence) fail("Native stdio summary precedes its raw chunks");
        const stats = summary.value.streams[channel];
        assertByteCount(stats.observedBytes, "Native stdio observed byte count is invalid");
        assertByteCount(stats.acceptedBytes, "Native stdio accepted byte count is invalid");
        assertByteCount(stats.chunkCount, "Native stdio chunk count is invalid");
        if (
          stats.observation !== observationFor(channel) ||
          stats.chunkCount !== streamChunks.length ||
          stats.acceptedBytes !== capturedBytes ||
          stats.observedBytes < stats.acceptedBytes ||
          (stats.complete && stats.observedBytes !== stats.acceptedBytes) ||
          (stats.complete && stats.incompleteReason !== null) ||
          (!stats.complete && !stats.incompleteReason)
        ) {
          fail("Native stdio summary differs from its chunks");
        }
        complete = stats.complete;
        observedBytes = stats.observedBytes;
        legacy = "none";
        incompleteReason = stats.incompleteReason;
      } else if (summary?.kind === "legacy") {
        const lastRaw = streamChunks.at(-1)?.sequence ?? 0;
        if (lastRaw > summary.sequence) fail("Legacy stdio summary precedes its raw chunks");
        const stats = summary.value.streams[channel];
        if (
          stats.observation !== observationFor(channel) ||
          summary.value.prefixLimitBytes !== 16_384 ||
          !Number.isSafeInteger(stats.observedBytes) ||
          stats.observedBytes < 0 ||
          !Number.isSafeInteger(stats.retainedBytes) ||
          stats.retainedBytes < 0 ||
          !Number.isSafeInteger(stats.publishedBytes) ||
          stats.publishedBytes < 0 ||
          stats.publishedBytes !== stats.retainedBytes ||
          stats.publishedBytes !== capturedBytes ||
          stats.publishedBytes > summary.value.prefixLimitBytes ||
          stats.observedBytes < stats.publishedBytes ||
          stats.truncated !== stats.observedBytes > summary.value.prefixLimitBytes
        ) {
          fail("Legacy native stdio prefix differs from its chunks");
        }
        complete = !stats.truncated && stats.observedBytes === stats.publishedBytes;
        observedBytes = stats.observedBytes;
        legacy = "prefix";
        incompleteReason = stats.truncated
          ? "legacy-16KiB-prefix"
          : complete
            ? null
            : "legacy-prefix-snapshot-incomplete";
      }
      inspected.push({
        incarnation,
        channel,
        complete,
        observedBytes,
        chunkCount: streamChunks.length,
        legacy,
        incompleteReason,
        capturedBytes,
        chunks: streamChunks,
      });
    }
  }
  return inspected.sort(
    (left, right) =>
      NATIVE_STDIO_CHANNELS.indexOf(left.channel) - NATIVE_STDIO_CHANNELS.indexOf(right.channel) ||
      left.incarnation.localeCompare(right.incarnation),
  );
}
