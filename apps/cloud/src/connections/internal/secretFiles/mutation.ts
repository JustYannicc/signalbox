import { BYTE_MATCHER_SCAN_CHUNK_BYTES, ByteMatcher, type ByteRangeReader } from "./byteMatcher.ts";
import {
  canonicalizeRaw,
  MAX_OPERATION_BYTES,
  MAX_SECRET_FILE_BYTES,
  projectCanonical,
  secretFileError,
  spanFootprint,
  type FillSpan,
  type PreparedSecretBindings,
} from "./projection.ts";
import type { Inode, Stat, Storage } from "../../../kernel/storage.ts";

const MAX_FILE_SIZE = (1n << 63n) - 1n;
const REF_MARKER_MATCHER = ByteMatcher.create(
  [
    { bytes: new TextEncoder().encode("{{secret:"), binding: 0 },
    { bytes: new TextEncoder().encode("{{op://"), binding: 1 },
  ],
  MAX_OPERATION_BYTES,
);

export type SecretFileMutation =
  | { readonly kind: "write"; readonly offset: bigint; readonly source: Uint8Array }
  | { readonly kind: "truncate"; readonly size: bigint };

type RawMutation = SecretFileMutation | { readonly kind: "append"; readonly source: Uint8Array };

export function mutateSecretFile(
  storage: Storage,
  inode: Inode,
  prepared: PreparedSecretBindings,
  mutation: SecretFileMutation,
): number {
  const stat = storage.stat(inode);
  assertRegularFile(stat);
  if (mutation.kind === "write" && mutation.source.byteLength > MAX_SECRET_FILE_BYTES) {
    throw secretFileError("ENOMEM");
  }

  const canonicalReader = storageReader(storage, inode);
  const cleanBefore = !needsProjection(canonicalReader, stat.size, prepared);
  if (cleanBefore) {
    const direct = tryCleanDirect(storage, inode, prepared, mutation, stat.size);
    if (direct !== undefined) return direct;
  } else if (stat.size > BigInt(MAX_SECRET_FILE_BYTES)) {
    throw secretFileError("ENOMEM");
  }

  return mutateWithKnownSize(storage, inode, prepared, mutation, stat);
}

export function appendSecretFile(
  storage: Storage,
  inode: Inode,
  prepared: PreparedSecretBindings,
  source: Uint8Array,
): { readonly offset: bigint; readonly bytesWritten: number } {
  const stat = storage.stat(inode);
  assertRegularFile(stat);
  if (source.byteLength > MAX_SECRET_FILE_BYTES) throw secretFileError("ENOMEM");
  const clean = !needsProjection(storageReader(storage, inode), stat.size, prepared);
  if (!clean && stat.size > BigInt(MAX_SECRET_FILE_BYTES)) throw secretFileError("ENOMEM");
  const offset = clean
    ? stat.size
    : BigInt(
        projectCanonical(readCanonical(storage, inode, stat, prepared), prepared).bytes.byteLength,
      );
  validateRange(offset, BigInt(source.byteLength));
  if (source.byteLength > 0) {
    const mutation: RawMutation = { kind: "append", source };
    if (clean) {
      const direct = tryCleanDirect(storage, inode, prepared, mutation, stat.size);
      if (direct !== undefined) return { offset, bytesWritten: direct };
    }
    mutateWithKnownSize(storage, inode, prepared, mutation, stat);
  }
  return { offset, bytesWritten: source.byteLength };
}

export function readSecretFile(
  storage: Storage,
  inode: Inode,
  prepared: PreparedSecretBindings,
  offset: bigint,
  target: Uint8Array,
): number {
  validateRange(offset, BigInt(target.byteLength));
  const stat = storage.stat(inode);
  assertRegularFile(stat);
  if (!needsProjection(storageReader(storage, inode), stat.size, prepared)) {
    return storage.readInto(inode, offset, target);
  }
  if (stat.size > BigInt(MAX_SECRET_FILE_BYTES)) throw secretFileError("ENOMEM");
  const projection = projectCanonical(
    readCanonical(storage, inode, stat, prepared),
    prepared,
  ).bytes;
  if (offset >= BigInt(projection.byteLength)) return 0;
  const start = Number(offset);
  const count = Math.min(target.byteLength, projection.byteLength - start);
  target.set(projection.subarray(start, start + count));
  return count;
}

export function statSecretFile(
  storage: Storage,
  inode: Inode,
  prepared: PreparedSecretBindings,
): Stat {
  const stat = storage.stat(inode);
  assertRegularFile(stat);
  if (!needsProjection(storageReader(storage, inode), stat.size, prepared)) {
    return stat;
  }
  if (stat.size > BigInt(MAX_SECRET_FILE_BYTES)) throw secretFileError("ENOMEM");
  const size = BigInt(
    projectCanonical(readCanonical(storage, inode, stat, prepared), prepared).bytes.byteLength,
  );
  return { ...stat, size };
}

function readCanonical(
  storage: Storage,
  inode: Inode,
  stat: Stat,
  prepared: PreparedSecretBindings,
): Uint8Array {
  validateSize(stat.size);
  if (stat.size > BigInt(MAX_SECRET_FILE_BYTES)) throw secretFileError("ENOMEM");
  if (prepared.stateBytes + Number(stat.size) > MAX_OPERATION_BYTES) {
    throw secretFileError("ENOMEM");
  }
  const bytes = new Uint8Array(Number(stat.size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const target = bytes.subarray(offset);
    const count = storage.readInto(inode, BigInt(offset), target);
    if (count <= 0 || count > target.byteLength) throw secretFileError("EIO");
    offset += count;
  }
  return bytes;
}

function tryCleanDirect(
  storage: Storage,
  inode: Inode,
  prepared: PreparedSecretBindings,
  mutation: RawMutation,
  oldSize: bigint,
): number | undefined {
  const plan = planMutation(mutation, oldSize);
  if (!plan.changed) return 0;
  const virtualReader = virtualRangeReader(storage, inode, oldSize, mutation, plan.postSize);
  if (needsProjection(virtualReader, plan.postSize, prepared)) {
    if (plan.postSize > BigInt(MAX_SECRET_FILE_BYTES)) throw secretFileError("ENOMEM");
    return undefined;
  }
  applyDirect(storage, inode, mutation, oldSize, plan);
  return plan.sourceLength;
}

function mutateWithKnownSize(
  storage: Storage,
  inode: Inode,
  prepared: PreparedSecretBindings,
  mutation: RawMutation,
  stat: Stat,
): number {
  const canonical = readCanonical(storage, inode, stat, prepared);
  const before = projectCanonical(canonical, prepared);
  const oldSize = BigInt(before.bytes.byteLength);
  const plan = planMutation(mutation, oldSize);
  if (!plan.changed) return 0;
  rejectPartialSpanMutation(before.spans, mutation, oldSize);
  if (plan.postSize > BigInt(MAX_SECRET_FILE_BYTES)) throw secretFileError("ENOMEM");
  const postSize = Number(plan.postSize);
  const postBufferBytes = plan.postSize > oldSize ? postSize : 0;
  const priorBufferBytes = distinctBufferBytes(canonical, before.bytes);
  const beforeSpanBytes = spanFootprint(before.spans, prepared);
  const preservedArrayBytes = 32 + countPreservedSpans(before.spans, mutation, oldSize) * 8;
  if (
    prepared.stateBytes +
      priorBufferBytes +
      postBufferBytes +
      beforeSpanBytes +
      preservedArrayBytes +
      64 >
    MAX_OPERATION_BYTES
  ) {
    throw secretFileError("ENOMEM");
  }
  const preserved = preservedSpans(before.spans, mutation, oldSize);
  const rawAfter = applyInMemory(before.bytes, mutation, plan);
  const alreadyOwnedBytes =
    distinctBufferBytesExcept(rawAfter, canonical, before.bytes) +
    beforeSpanBytes +
    preservedArrayBytes;
  const canonicalAfter = canonicalizeRaw(rawAfter, preserved, prepared, alreadyOwnedBytes);
  publish(storage, inode, canonicalAfter);
  return plan.sourceLength;
}

interface MutationPlan {
  readonly sourceLength: number;
  readonly start: bigint;
  readonly end: bigint;
  readonly postSize: bigint;
  readonly changed: boolean;
}

function planMutation(mutation: RawMutation, oldSize: bigint): MutationPlan {
  if (mutation.kind === "truncate") {
    validateSize(mutation.size);
    return {
      sourceLength: 0,
      start: mutation.size,
      end: oldSize,
      postSize: mutation.size,
      changed: mutation.size !== oldSize,
    };
  }
  const start = mutation.kind === "append" ? oldSize : mutation.offset;
  const sourceLength = mutation.source.byteLength;
  const end = start + BigInt(sourceLength);
  validateRange(start, BigInt(sourceLength));
  if (sourceLength > MAX_SECRET_FILE_BYTES) throw secretFileError("ENOMEM");
  return {
    sourceLength,
    start,
    end,
    postSize: end > oldSize ? end : oldSize,
    changed: sourceLength > 0,
  };
}

function rejectPartialSpanMutation(
  spans: ReadonlyArray<FillSpan>,
  mutation: RawMutation,
  oldSize: bigint,
): void {
  if (mutation.kind === "truncate") {
    for (const span of spans) {
      const start = BigInt(span.start);
      const end = BigInt(span.end);
      if (start < mutation.size && mutation.size < end) throw secretFileError("ENOTSUP");
    }
    return;
  }
  const start = mutation.kind === "append" ? oldSize : mutation.offset;
  const end = start + BigInt(mutation.source.byteLength);
  for (const span of spans) {
    const spanStart = BigInt(span.start);
    const spanEnd = BigInt(span.end);
    if (start < spanEnd && end > spanStart && !(start <= spanStart && end >= spanEnd)) {
      throw secretFileError("ENOTSUP");
    }
  }
}

function preservedSpans(
  spans: ReadonlyArray<FillSpan>,
  mutation: RawMutation,
  oldSize: bigint,
): ReadonlyArray<FillSpan> {
  if (mutation.kind === "truncate") {
    return spans.filter((span) => BigInt(span.end) <= mutation.size);
  }
  const start = mutation.kind === "append" ? oldSize : mutation.offset;
  const end = start + BigInt(mutation.source.byteLength);
  return spans.filter((span) => !(start < BigInt(span.end) && end > BigInt(span.start)));
}

function countPreservedSpans(
  spans: ReadonlyArray<FillSpan>,
  mutation: RawMutation,
  oldSize: bigint,
): number {
  if (mutation.kind === "truncate") {
    let count = 0;
    for (const span of spans) if (BigInt(span.end) <= mutation.size) count += 1;
    return count;
  }
  const start = mutation.kind === "append" ? oldSize : mutation.offset;
  const end = start + BigInt(mutation.source.byteLength);
  let count = 0;
  for (const span of spans) {
    if (!(start < BigInt(span.end) && end > BigInt(span.start))) count += 1;
  }
  return count;
}

function distinctBufferBytes(left: Uint8Array, right: Uint8Array): number {
  if (left.buffer === right.buffer) return left.buffer.byteLength;
  return left.buffer.byteLength + right.buffer.byteLength;
}

function distinctBufferBytesExcept(
  excluded: Uint8Array,
  first: Uint8Array,
  second: Uint8Array,
): number {
  let bytes = 0;
  if (first.buffer !== excluded.buffer) bytes += first.buffer.byteLength;
  if (second.buffer !== excluded.buffer && second.buffer !== first.buffer) {
    bytes += second.buffer.byteLength;
  }
  return bytes;
}

function applyInMemory(raw: Uint8Array, mutation: RawMutation, plan: MutationPlan): Uint8Array {
  if (mutation.kind === "truncate") {
    if (plan.postSize <= BigInt(raw.byteLength)) return raw.subarray(0, Number(plan.postSize));
    const extended = new Uint8Array(Number(plan.postSize));
    extended.set(raw);
    return extended;
  }
  const output =
    plan.postSize === BigInt(raw.byteLength) ? raw : new Uint8Array(Number(plan.postSize));
  if (output !== raw) output.set(raw);
  output.set(mutation.source, Number(plan.start));
  return output;
}

function applyDirect(
  storage: Storage,
  inode: Inode,
  mutation: RawMutation,
  oldSize: bigint,
  plan: MutationPlan,
): void {
  if (mutation.kind === "truncate") {
    storage.truncate(inode, mutation.size);
    return;
  }
  if (mutation.kind === "append") {
    const result = storage.append(inode, mutation.source);
    if (result.offset !== oldSize || result.bytesWritten !== mutation.source.byteLength) {
      throw secretFileError("EIO");
    }
    return;
  }
  if (storage.write(inode, mutation.offset, mutation.source) !== plan.sourceLength) {
    throw secretFileError("EIO");
  }
}

function virtualRangeReader(
  storage: Storage,
  inode: Inode,
  oldCanonicalSize: bigint,
  mutation: RawMutation,
  postSize: bigint,
): ByteRangeReader {
  const plan = planMutation(mutation, oldCanonicalSize);
  return (offset, target) => {
    validateRange(offset, BigInt(target.byteLength));
    target.fill(0);
    if (offset >= postSize || target.byteLength === 0) return 0;
    const available = Number(
      postSize - offset < BigInt(target.byteLength) ? postSize - offset : BigInt(target.byteLength),
    );
    let cursor = 0;
    const rangeStart = offset;
    const rangeEnd = offset + BigInt(available);
    const writeStart = mutation.kind === "truncate" ? plan.postSize : plan.start;
    const writeEnd = mutation.kind === "truncate" ? plan.postSize : plan.end;

    while (cursor < available) {
      const position = rangeStart + BigInt(cursor);
      if (mutation.kind !== "truncate" && position >= writeStart && position < writeEnd) {
        const sourceOffset = Number(position - writeStart);
        const count = Math.min(available - cursor, mutation.source.byteLength - sourceOffset);
        target.set(mutation.source.subarray(sourceOffset, sourceOffset + count), cursor);
        cursor += count;
        continue;
      }
      if (position >= oldCanonicalSize) {
        const zeroEnd =
          mutation.kind !== "truncate" && position < writeStart
            ? writeStart < rangeEnd
              ? writeStart
              : rangeEnd
            : rangeEnd;
        cursor += Number(zeroEnd - position);
        continue;
      }
      const nextBoundary =
        mutation.kind === "truncate"
          ? rangeEnd
          : position < writeStart
            ? writeStart < rangeEnd
              ? writeStart
              : rangeEnd
            : rangeEnd;
      const count = Math.min(
        available - cursor,
        Number(nextBoundary - position),
        Number(oldCanonicalSize - position),
      );
      if (count === 0) throw secretFileError("EIO");
      const read = storage.readInto(inode, position, target.subarray(cursor, cursor + count));
      if (read !== count) throw secretFileError("EIO");
      cursor += count;
    }
    return available;
  };
}

function needsProjection(
  readInto: ByteRangeReader,
  size: bigint,
  prepared: PreparedSecretBindings,
): boolean {
  const available = MAX_OPERATION_BYTES - prepared.stateBytes;
  const chunkBytes = Number(
    size < BigInt(BYTE_MATCHER_SCAN_CHUNK_BYTES) ? size : BigInt(BYTE_MATCHER_SCAN_CHUNK_BYTES),
  );
  if (size > 0n && available < 1) throw secretFileError("ENOMEM");
  const boundedChunkBytes = Math.min(chunkBytes, available);
  if (!REF_MARKER_MATCHER.scanReader(size, readInto, () => false, boundedChunkBytes)) return true;
  if (prepared.matcher.patternCount === 0) return false;
  let matched = false;
  prepared.matcher.scanReader(
    size,
    readInto,
    () => {
      matched = true;
      return false;
    },
    boundedChunkBytes,
  );
  return matched;
}

function storageReader(storage: Storage, inode: Inode): ByteRangeReader {
  return (offset, target) => storage.readInto(inode, offset, target);
}

function publish(storage: Storage, inode: Inode, bytes: Uint8Array): void {
  storage.truncate(inode, 0n);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const source = bytes.subarray(offset);
    const count = storage.write(inode, BigInt(offset), source);
    if (count <= 0 || count > source.byteLength) throw secretFileError("EIO");
    offset += count;
  }
}

function assertRegularFile(stat: Stat): void {
  if (stat.type === "directory") throw secretFileError("EISDIR");
  if (stat.type !== "file") throw secretFileError("EINVAL");
  validateSize(stat.size);
}

export function validateRange(offset: bigint, length: bigint): void {
  validateSize(offset);
  if (length < 0n) throw secretFileError("EINVAL");
  validateSize(offset + length);
}

export function validateSize(size: bigint): void {
  if (size < 0n) throw secretFileError("EINVAL");
  if (size > MAX_FILE_SIZE) throw secretFileError("EFBIG");
}
