import { routesHarness } from "@signalbox/runner-protocol/HarnessSecretPolicy";
import { MIN_SCRUBBED_LENGTH, secretForms } from "@signalbox/runner-protocol/SecretScrubber";
import { ByteMatcher, type ByteMatch, type BytePattern } from "./byteMatcher.ts";
import { estimateSecretFormsScratch } from "./secretFormsBudget.ts";

export const MAX_SECRET_FILE_BYTES = 1_048_576;

const utf8 = new TextEncoder();
const secretPlaceholder = /^\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}$/;
const opPlaceholder = /^\{\{op:\/\/[^{}]+\}\}$/;
const secretMarker = utf8.encode("{{secret:");
const opMarker = utf8.encode("{{op://");
const closeMarker = new Uint8Array([0x7d, 0x7d]);
const EMPTY_SPANS: ReadonlyArray<FillSpan> = [];

export interface SecretFileBindingInput {
  readonly placeholder: string;
  readonly value: string;
}

interface PreparedBinding {
  readonly placeholder: Uint8Array;
  readonly value: Uint8Array;
}

export interface PreparedSecretBindings {
  readonly bindings: ReadonlyArray<PreparedBinding>;
  readonly bindingsByHash: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly matcher: ByteMatcher;
  readonly stateBytes: number;
}

export interface FillSpan {
  readonly start: number;
  readonly end: number;
  readonly binding: number;
}

interface ReplacementSpan {
  start: number;
  end: number;
  bindings: Array<number>;
}

export interface Projection {
  readonly bytes: Uint8Array;
  readonly spans: ReadonlyArray<FillSpan>;
}

export function prepareSecretBindings(
  inputs: ReadonlyArray<SecretFileBindingInput>,
): PreparedSecretBindings {
  if (!Array.isArray(inputs)) throw secretFileError("EINVAL");
  const bindings: Array<PreparedBinding> = [];
  const byPlaceholder = new Map<string, number>();
  const bindingsByHash = new Map<string, Array<number>>();
  const patternByText = new Map<string, { bytes: Uint8Array; binding: number }>();
  let bindingBytes = 0;
  let patternBytes = 0;

  for (const input of inputs) {
    if (
      input === null ||
      typeof input !== "object" ||
      typeof input.placeholder !== "string" ||
      typeof input.value !== "string" ||
      input.value.length < MIN_SCRUBBED_LENGTH ||
      !isWellFormedUtf16(input.placeholder) ||
      !isWellFormedUtf16(input.value)
    ) {
      throw secretFileError("EINVAL");
    }
    const name = secretPlaceholder.exec(input.placeholder)?.[1];
    if (name !== undefined && routesHarness(name)) {
      throw secretFileError("EINVAL");
    }
    if (name === undefined && !opPlaceholder.test(input.placeholder)) {
      throw secretFileError("EINVAL");
    }
    if (byPlaceholder.has(input.placeholder)) throw secretFileError("EINVAL");

    const bindingIndex = bindings.length;
    const remainingPayloadBytes = MAX_OPERATION_BYTES - bindingBytes - patternBytes - 160;
    const placeholderLength = utf8ByteLength(
      input.placeholder,
      Math.floor(remainingPayloadBytes / 2),
    );
    const valueLength = utf8ByteLength(input.value, remainingPayloadBytes - placeholderLength * 2);
    const nextBindingBytes = bindingBytes + placeholderLength + valueLength + 160;
    const formsScratch = estimateSecretFormsScratch(input.value, valueLength);
    if (nextBindingBytes + patternBytes + formsScratch.peakBytes > MAX_OPERATION_BYTES) {
      throw secretFileError("ENOMEM");
    }
    const placeholder = utf8.encode(input.placeholder);
    const value = utf8.encode(input.value);
    // Placeholder/value bytes plus conservative fixed rows for the lookup maps and binding.
    bindingBytes = nextBindingBytes;
    bindings.push({ placeholder, value });
    byPlaceholder.set(input.placeholder, bindingIndex);
    const hash = tokenHash(placeholder, 0, placeholder.byteLength);
    const sameHash = bindingsByHash.get(hash);
    if (sameHash === undefined) bindingsByHash.set(hash, [bindingIndex]);
    else sameHash.push(bindingIndex);

    const forms = secretForms(input.value);
    let pendingNewFormBytes = 0;
    let duplicateFormBytes = 0;
    for (const form of forms) {
      const stringBytes = form.length * 2;
      if (patternByText.has(form)) duplicateFormBytes += stringBytes;
      else pendingNewFormBytes += stringBytes;
    }
    const formsArrayBytes = 32 + forms.length * 8;
    if (
      bindingBytes + patternBytes + pendingNewFormBytes + duplicateFormBytes + formsArrayBytes >
      MAX_OPERATION_BYTES
    ) {
      throw secretFileError("ENOMEM");
    }
    for (const form of forms) {
      const stringBytes = form.length * 2;
      if (patternByText.has(form)) continue;
      const remainingFormBytes = pendingNewFormBytes - stringBytes;
      const availableForPattern =
        MAX_OPERATION_BYTES -
        bindingBytes -
        patternBytes -
        remainingFormBytes -
        duplicateFormBytes -
        formsArrayBytes -
        64;
      if (availableForPattern < 0) throw secretFileError("ENOMEM");
      const formLength = utf8ByteLength(form, Math.floor(availableForPattern / 2));
      const nextPatternBytes = patternBytes + stringBytes + formLength + 64;
      if (
        bindingBytes +
          nextPatternBytes +
          remainingFormBytes +
          duplicateFormBytes +
          formsArrayBytes >
        MAX_OPERATION_BYTES
      ) {
        throw secretFileError("ENOMEM");
      }
      const bytes = form === input.value ? value : utf8.encode(form);
      // Charge the form text, encoded matcher input, and map/pattern rows during construction.
      patternBytes = nextPatternBytes;
      patternByText.set(form, { bytes, binding: bindingIndex });
      pendingNewFormBytes = remainingFormBytes;
    }
  }

  byPlaceholder.clear();
  const patterns: Array<BytePattern> = [...patternByText.values()];
  const matcher = ByteMatcher.create(patterns, MAX_OPERATION_BYTES - bindingBytes - patternBytes);
  const stateBytes = bindingBytes + matcher.byteSize;
  if (stateBytes > MAX_OPERATION_BYTES) throw secretFileError("ENOMEM");
  return {
    bindings,
    bindingsByHash,
    matcher,
    stateBytes,
  };
}

export function projectCanonical(
  canonical: Uint8Array,
  prepared: PreparedSecretBindings,
): Projection {
  if (canonical.byteLength > MAX_SECRET_FILE_BYTES) throw secretFileError("ENOMEM");
  if (prepared.stateBytes + canonical.byteLength + 64 > MAX_OPERATION_BYTES) {
    throw secretFileError("ENOMEM");
  }
  const references: Array<FillSpan> = [];
  let rawSize = canonical.byteLength;
  let referencesFootprint = 0;
  for (const reference of referencesIn(canonical, prepared)) {
    referencesFootprint += 32 + prepared.bindings[reference.binding]!.placeholder.byteLength;
    rawSize +=
      prepared.bindings[reference.binding]!.value.byteLength - (reference.end - reference.start);
    if (
      rawSize > MAX_SECRET_FILE_BYTES ||
      prepared.stateBytes + canonical.byteLength + rawSize + 2 * referencesFootprint + 64 >
        MAX_OPERATION_BYTES
    ) {
      throw secretFileError("ENOMEM");
    }
    references.push(reference);
  }
  if (references.length === 0) return { bytes: canonical, spans: EMPTY_SPANS };

  const raw = new Uint8Array(rawSize);
  let sourceAt = 0;
  let rawAt = 0;
  const spans: Array<FillSpan> = [];
  for (const reference of references) {
    const prefixLength = reference.start - sourceAt;
    raw.set(canonical.subarray(sourceAt, reference.start), rawAt);
    rawAt += prefixLength;
    const value = prepared.bindings[reference.binding]!.value;
    raw.set(value, rawAt);
    spans.push({ start: rawAt, end: rawAt + value.byteLength, binding: reference.binding });
    rawAt += value.byteLength;
    sourceAt = reference.end;
  }
  raw.set(canonical.subarray(sourceAt), rawAt);
  return { bytes: raw, spans };
}

/** Scrubs a complete post-mutation representation, then verifies the raw view round-trips. */
export function canonicalizeRaw(
  raw: Uint8Array,
  preservedSpans: ReadonlyArray<FillSpan>,
  prepared: PreparedSecretBindings,
  alreadyOwnedBytes = 0,
): Uint8Array {
  assertNoReferencesOutsideSpans(raw, preservedSpans, prepared);
  const replacements: Array<ReplacementSpan> = [];
  const preservedFootprint = spanFootprint(preservedSpans, prepared);
  const rawOwnedBytes = raw.buffer.byteLength;
  const mapCapacity = MAX_OPERATION_BYTES - prepared.stateBytes - alreadyOwnedBytes - rawOwnedBytes;
  if (mapCapacity < preservedFootprint) throw secretFileError("ENOMEM");
  const replacementCapacity = mapCapacity - preservedFootprint;
  let replacementsFootprint = 0;
  for (const span of preservedSpans) {
    replacementsFootprint = insertSpan(
      replacements,
      span.start,
      span.end,
      span.binding,
      replacementsFootprint,
      replacementCapacity,
    );
  }
  prepared.matcher.scan(raw, (match) => {
    // The original token already hides any match crossing its untouched value.
    if (preservedSpans.some((span) => span.start < match.end && span.end > match.start)) return;
    const [start, end] = escapeSafeRange(raw, match);
    if (preservedSpans.some((span) => span.start < end && span.end > start)) {
      throw secretFileError("ENOTSUP");
    }
    replacementsFootprint = insertSpan(
      replacements,
      start,
      end,
      match.binding,
      replacementsFootprint,
      replacementCapacity,
    );
  });

  let canonicalSize = raw.byteLength;
  for (const replacement of replacements) {
    const replacementBytes = replacement.bindings.reduce(
      (size, binding) => size + prepared.bindings[binding]!.placeholder.byteLength,
      0,
    );
    canonicalSize += replacementBytes - (replacement.end - replacement.start);
  }
  const mapFootprint = replacementsFootprint + preservedFootprint;
  if (
    canonicalSize > MAX_SECRET_FILE_BYTES ||
    prepared.stateBytes + alreadyOwnedBytes + rawOwnedBytes + canonicalSize + mapFootprint >
      MAX_OPERATION_BYTES
  ) {
    throw secretFileError("ENOMEM");
  }

  const canonical = new Uint8Array(canonicalSize);
  let rawAt = 0;
  let canonicalAt = 0;
  for (const replacement of replacements) {
    const prefixLength = replacement.start - rawAt;
    canonical.set(raw.subarray(rawAt, replacement.start), canonicalAt);
    canonicalAt += prefixLength;
    for (const binding of replacement.bindings) {
      const placeholder = prepared.bindings[binding]!.placeholder;
      canonical.set(placeholder, canonicalAt);
      canonicalAt += placeholder.byteLength;
    }
    rawAt = replacement.end;
  }
  canonical.set(raw.subarray(rawAt), canonicalAt);

  for (const replacement of replacements) {
    const expectedLength = replacement.bindings.reduce(
      (size, binding) => size + prepared.bindings[binding]!.value.byteLength,
      0,
    );
    if (expectedLength !== replacement.end - replacement.start) throw secretFileError("ENOTSUP");
    let expectedAt = replacement.start;
    for (const binding of replacement.bindings) {
      const value = prepared.bindings[binding]!.value;
      if (!sameBytes(raw.subarray(expectedAt, expectedAt + value.byteLength), value)) {
        throw secretFileError("ENOTSUP");
      }
      expectedAt += value.byteLength;
    }
  }
  return canonical;
}

function* referencesIn(bytes: Uint8Array, prepared: PreparedSecretBindings): Generator<FillSpan> {
  for (let at = 0; at < bytes.byteLength;) {
    const markerLength = markerAt(bytes, at);
    if (markerLength === 0) {
      at += 1;
      continue;
    }
    const reference = readReference(bytes, at, markerLength, prepared);
    yield reference;
    at = reference.end;
  }
}

function assertNoReferencesOutsideSpans(
  bytes: Uint8Array,
  preservedSpans: ReadonlyArray<FillSpan>,
  prepared: PreparedSecretBindings,
): void {
  const assertRegion = (start: number, end: number) => {
    if (start === end) return;
    for (const _reference of referencesIn(bytes.subarray(start, end), prepared)) {
      throw secretFileError("ENOTSUP");
    }
  };

  let cursor = 0;
  for (const span of preservedSpans) {
    if (span.start < cursor || span.end < span.start || span.end > bytes.byteLength) {
      throw secretFileError("EINVAL");
    }
    assertRegion(cursor, span.start);
    cursor = span.end;
  }
  assertRegion(cursor, bytes.byteLength);
}

export function secretFileError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function spanFootprint(
  spans: ReadonlyArray<FillSpan>,
  prepared: PreparedSecretBindings,
): number {
  return spans.reduce(
    (size, span) => size + 32 + prepared.bindings[span.binding]!.placeholder.byteLength,
    0,
  );
}

// Bound retained state, live canonical/raw copies, and span/map metadata together.
export const MAX_OPERATION_BYTES = 4 * 1024 * 1024;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function utf8ByteLength(value: string, maximum: number): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (length > maximum) throw secretFileError("ENOMEM");
  }
  return length;
}

function readReference(
  bytes: Uint8Array,
  start: number,
  markerLength: number,
  prepared: PreparedSecretBindings,
): FillSpan {
  let close = -1;
  for (let at = start + markerLength; at < bytes.byteLength; at += 1) {
    const byte = bytes[at]!;
    if (byte === 0x7b || byte === 0x7d) {
      if (byte === 0x7d && bytes[at + 1] === 0x7d) {
        close = at;
        break;
      }
      throw secretFileError("EINVAL");
    }
  }
  if (close === -1) throw secretFileError("EINVAL");
  const end = close + closeMarker.byteLength;
  const candidates = prepared.bindingsByHash.get(tokenHash(bytes, start, end));
  if (candidates === undefined) throw secretFileError("EINVAL");
  for (const binding of candidates) {
    if (sameByteRange(bytes, start, end, prepared.bindings[binding]!.placeholder)) {
      return { start, end, binding };
    }
  }
  throw secretFileError("EINVAL");
}

function tokenHash(bytes: Uint8Array, start: number, end: number): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index]!;
    first = Math.imul(first ^ byte, 0x01000193);
    second = Math.imul(second ^ (byte + index - start), 0x85ebca6b);
  }
  return `${end - start}:${first >>> 0}:${second >>> 0}`;
}

function sameByteRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  expected: Uint8Array,
): boolean {
  if (end - start !== expected.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (bytes[start + index] !== expected[index]) return false;
  }
  return true;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function markerAt(bytes: Uint8Array, at: number): number {
  if (matchesAt(bytes, at, secretMarker)) return secretMarker.byteLength;
  if (matchesAt(bytes, at, opMarker)) return opMarker.byteLength;
  return 0;
}

function matchesAt(bytes: Uint8Array, at: number, pattern: Uint8Array): boolean {
  if (at + pattern.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < pattern.byteLength; index += 1) {
    if (bytes[at + index] !== pattern[index]) return false;
  }
  return true;
}

function escapeSafeRange(bytes: Uint8Array, match: ByteMatch): readonly [number, number] {
  let start = match.start;
  let end = match.end;
  if (backslashesBefore(bytes, start) % 2 === 1 && start > 0) start -= 1;
  if (backslashesBefore(bytes, end) % 2 === 1 && end < bytes.byteLength) {
    end += utf8SequenceLength(bytes[end]!);
  }
  return [start, Math.min(end, bytes.byteLength)];
}

function backslashesBefore(bytes: Uint8Array, at: number): number {
  let count = 0;
  for (let index = at - 1; index >= 0 && bytes[index] === 0x5c; index -= 1) count += 1;
  return count;
}

function utf8SequenceLength(firstByte: number): number {
  if ((firstByte & 0x80) === 0) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  return 1;
}

function insertSpan(
  spans: Array<ReplacementSpan>,
  start: number,
  end: number,
  binding: number,
  currentFootprint: number,
  maxFootprint: number,
): number {
  if (start < 0 || end <= start) throw secretFileError("EINVAL");
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (spans[middle]!.start < start) low = middle + 1;
    else high = middle;
  }

  let first = low;
  if (first > 0 && spans[first - 1]!.end > start) first -= 1;
  let last = first;
  let mergedStart = start;
  let mergedEnd = end;
  let removedFootprint = 0;
  let copiedBindingCount = 1;
  while (last < spans.length && spans[last]!.start < mergedEnd) {
    const existing = spans[last]!;
    if (existing.end > mergedStart) {
      mergedStart = Math.min(mergedStart, existing.start);
      mergedEnd = Math.max(mergedEnd, existing.end);
      removedFootprint += 32 + existing.bindings.length * 8;
      copiedBindingCount += existing.bindings.length;
    }
    last += 1;
  }

  // Old bindings remain live while a replacement span is assembled.
  if (currentFootprint + 32 + copiedBindingCount * 8 > maxFootprint) {
    throw secretFileError("ENOMEM");
  }
  const merged: ReplacementSpan = { start: mergedStart, end: mergedEnd, bindings: [binding] };
  for (let index = first; index < last; index += 1) {
    const existing = spans[index]!;
    if (existing.end <= mergedStart || existing.start >= mergedEnd) continue;
    for (const name of existing.bindings) addBinding(merged.bindings, name);
  }
  addBinding(merged.bindings, binding);
  merged.bindings.sort((left, right) => left - right);
  if (last > first) spans.splice(first, last - first);
  spans.splice(first, 0, merged);
  const nextFootprint = currentFootprint - removedFootprint + 32 + merged.bindings.length * 8;
  if (nextFootprint > maxFootprint) throw secretFileError("ENOMEM");
  return nextFootprint;
}

function addBinding(bindings: Array<number>, binding: number): void {
  if (bindings.includes(binding)) return;
  bindings.push(binding);
}
