import type { SearchDelivery, SearchDocument, SearchDocumentPart } from "../search/SearchIndex.ts";
import { SearchDocumentPart as SearchDocumentPartSchema } from "../search/SearchIndex.ts";
import * as Schema from "effect/Schema";

const SEARCH_PART_MAX_CODE_UNITS = 16 * 1024;
export const SEARCH_DELIVERY_MAX_BYTES = 256 * 1024;
export const SEARCH_THREAD_TITLE_MAX_ENCODED_BYTES = 1024;
const SearchDocumentPartJson = Schema.fromJsonString(SearchDocumentPartSchema);
const encodePart = Schema.encodeSync(SearchDocumentPartJson);

const jsonStringContentBytes = (value: string): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength - 2;

/** Titles are cached in every outbox row; the full title stays in the thread search document. */
export const boundSearchThreadMetadata = (
  thread: SearchDelivery["thread"],
): SearchDelivery["thread"] => {
  let title = "";
  let encodedBytes = 0;
  for (const character of thread.title) {
    const nextBytes = jsonStringContentBytes(character);
    if (encodedBytes + nextBytes > SEARCH_THREAD_TITLE_MAX_ENCODED_BYTES) break;
    title += character;
    encodedBytes += nextBytes;
  }
  return title === thread.title ? thread : { ...thread, title };
};

/** Split by Unicode code point while keeping offsets in the protocol's UTF-16 units. */
export const splitSearchDocument = (
  document: SearchDocument,
): ReadonlyArray<SearchDocumentPart> => {
  const parts: Array<SearchDocumentPart> = [];
  let offset = 0;
  for (
    let part = searchDocumentPartAt(document, offset);
    part !== null;
    part = searchDocumentPartAt(document, offset)
  ) {
    parts.push(part);
    offset += part.text.length;
    if (document.text.length === 0) break;
  }
  return parts;
};

const searchDocumentPartAt = (
  document: SearchDocument,
  offset: number,
): SearchDocumentPart | null => {
  if (document.text.length === 0) {
    return offset === 0 ? { ...document, text: "", offset: 0, totalLength: 0 } : null;
  }
  if (offset >= document.text.length) return null;
  let end = Math.min(offset + SEARCH_PART_MAX_CODE_UNITS, document.text.length);
  if (end < document.text.length) {
    const last = document.text.charCodeAt(end - 1);
    const next = document.text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return {
    ...document,
    text: document.text.slice(offset, end),
    offset,
    totalLength: document.text.length,
  };
};

export const splitSearchDocumentPart = (
  part: SearchDocumentPart,
): readonly [SearchDocumentPart, SearchDocumentPart] | null => {
  let middle = Math.floor(part.text.length / 2);
  if (middle <= 0 || middle >= part.text.length) return null;
  const before = part.text.charCodeAt(middle - 1);
  const after = part.text.charCodeAt(middle);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) middle -= 1;
  if (middle <= 0) return null;
  return [
    { ...part, text: part.text.slice(0, middle) },
    { ...part, text: part.text.slice(middle), offset: part.offset + middle },
  ];
};

export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export const searchPartBytes = (part: SearchDocumentPart): number => utf8Bytes(encodePart(part));

export const searchRemovedItemBytes = (itemId: string): number => utf8Bytes(JSON.stringify(itemId));

/** The part and removed arrays are empty in `base`; false reserves the longer flag. */
export interface SearchDeliveryBaseSize {
  readonly envelope: number;
  readonly row: number;
}

export const searchDeliveryBaseSize = (
  base: Pick<
    SearchDelivery,
    "home" | "thread" | "revision" | "sourceSequence" | "deliveryId" | "snapshot"
  >,
  encodeDelivery: (delivery: SearchDelivery) => string,
  page: number,
): SearchDeliveryBaseSize => {
  const encoded = encodeDelivery({
    ...base,
    documents: [],
    parts: [],
    removed: [],
    complete: false,
  });
  return {
    envelope: utf8Bytes(encoded),
    row: utf8Bytes(
      JSON.stringify({
        revision: base.revision,
        page,
        deliveryId: base.deliveryId,
        delivery: encoded,
      }),
    ),
  };
};

const escapedJsonContentBytes = (value: string): number => utf8Bytes(JSON.stringify(value)) - 2;

export const searchPartRowBytes = (
  position: number,
  itemId: string,
  offset: number,
  part: string,
): number => utf8Bytes(JSON.stringify({ position, itemId, offset, part }));

export const searchDeliveryRowBytes = (
  revision: number,
  page: number,
  deliveryId: string,
  delivery: string,
): number => utf8Bytes(JSON.stringify({ revision, page, deliveryId, delivery }));

export const searchDeliveryBytes = (
  base: SearchDeliveryBaseSize,
  partsBytes: number,
  partCount: number,
  removedBytes: number,
  removedCount: number,
  escapedPartsBytes: number,
  escapedRemovedBytes: number,
): SearchDeliveryBaseSize => {
  const partSeparators = Math.max(0, partCount - 1);
  const removedSeparators = Math.max(0, removedCount - 1);
  return {
    envelope: base.envelope + partsBytes + partSeparators + removedBytes + removedSeparators,
    row: base.row + escapedPartsBytes + partSeparators + escapedRemovedBytes + removedSeparators,
  };
};

export const searchDeliveryWithinLimit = (size: SearchDeliveryBaseSize): boolean =>
  size.envelope <= SEARCH_DELIVERY_MAX_BYTES && size.row <= SEARCH_DELIVERY_MAX_BYTES;

export const searchPartEscapedBytes = (part: SearchDocumentPart): number =>
  escapedJsonContentBytes(encodePart(part));

export const searchRemovedItemEscapedBytes = (itemId: string): number =>
  escapedJsonContentBytes(JSON.stringify(itemId));

/** Reads only a bounded prefix of a legacy document for a resumable conversion. */
export const boundedSearchDocumentParts = (
  document: SearchDocument,
  offset: number,
  byteBudget: number,
): {
  readonly parts: ReadonlyArray<SearchDocumentPart>;
  readonly nextOffset: number;
  readonly blocked: boolean;
} => {
  const parts: Array<SearchDocumentPart> = [];
  let nextOffset = offset;
  let usedBytes = 0;
  while (
    nextOffset < document.text.length ||
    (document.text.length === 0 && nextOffset === 0 && parts.length === 0)
  ) {
    let part = searchDocumentPartAt(document, nextOffset);
    if (part === null) break;
    let bytes = searchPartRowBytes(part.position, part.itemId, part.offset, encodePart(part));
    while (bytes > SEARCH_DELIVERY_MAX_BYTES || (parts.length === 0 && bytes > byteBudget)) {
      const split = splitSearchDocumentPart(part);
      if (split === null) {
        if (bytes <= SEARCH_DELIVERY_MAX_BYTES) break;
        return { parts: [], nextOffset: offset, blocked: true };
      }
      part = split[0];
      bytes = searchPartRowBytes(part.position, part.itemId, part.offset, encodePart(part));
    }
    if (parts.length > 0 && usedBytes + bytes > byteBudget) break;
    parts.push(part);
    usedBytes += bytes;
    nextOffset += part.text.length;
    if (document.text.length === 0) break;
  }
  return { parts, nextOffset, blocked: false };
};

export interface LegacyDeliveryCursor {
  readonly document: number;
  readonly offset: number;
  readonly removed: number;
}

export const firstLegacyDeliveryCursor: LegacyDeliveryCursor = {
  document: 0,
  offset: 0,
  removed: 0,
};

/** Converts one bounded portion of an old whole-document outbox row. */
export const takeLegacyDeliveryChunk = (
  source: SearchDelivery,
  cursor: LegacyDeliveryCursor,
  deliveryId: string,
  rowPage: number,
  encodeDelivery: (delivery: SearchDelivery) => string,
): {
  readonly delivery: SearchDelivery;
  readonly cursor: LegacyDeliveryCursor;
  readonly done: boolean;
} => {
  if (source.snapshot !== undefined && source.documents.length > 0) {
    throw new Error("Snapshot deliveries must already use bounded parts.");
  }
  if (source.parts !== undefined && source.parts.length > 0) {
    throw new Error("Legacy conversion does not accept an outbox row that already has parts.");
  }
  const thread = boundSearchThreadMetadata(source.thread);
  const base = {
    home: source.home,
    thread,
    revision: source.revision,
    sourceSequence: source.sourceSequence,
    deliveryId,
  };
  const baseSize = searchDeliveryBaseSize(base, encodeDelivery, rowPage);
  const parts: Array<SearchDocumentPart> = [];
  const removed: Array<string> = [];
  let partsBytes = 0;
  let removedBytes = 0;
  let escapedPartsBytes = 0;
  let escapedRemovedBytes = 0;
  let document = cursor.document;
  let offset = cursor.offset;
  let removedIndex = cursor.removed;
  while (document < source.documents.length) {
    const current = source.documents[document]!;
    let part = searchDocumentPartAt(current, offset);
    if (part === null) {
      document += 1;
      offset = 0;
      continue;
    }
    let partSize = searchPartBytes(part);
    let escapedPartSize = searchPartEscapedBytes(part);
    while (
      !searchDeliveryWithinLimit(
        searchDeliveryBytes(
          baseSize,
          partsBytes + partSize,
          parts.length + 1,
          removedBytes,
          removed.length,
          escapedPartsBytes + escapedPartSize,
          escapedRemovedBytes,
        ),
      )
    ) {
      if (parts.length > 0 || removed.length > 0) {
        part = null;
        break;
      }
      const split = splitSearchDocumentPart(part);
      if (split === null) throw new Error("A legacy search part exceeds the delivery byte limit.");
      part = split[0];
      partSize = searchPartBytes(part);
      escapedPartSize = searchPartEscapedBytes(part);
    }
    if (part === null) break;
    parts.push(part);
    partsBytes += partSize;
    escapedPartsBytes += escapedPartSize;
    offset += part.text.length;
    if (offset >= current.text.length) {
      document += 1;
      offset = 0;
    }
  }
  while (document >= source.documents.length && removedIndex < source.removed.length) {
    const itemId = source.removed[removedIndex]!;
    const itemBytes = searchRemovedItemBytes(itemId);
    const escapedItemBytes = searchRemovedItemEscapedBytes(itemId);
    if (
      !searchDeliveryWithinLimit(
        searchDeliveryBytes(
          baseSize,
          partsBytes,
          parts.length,
          removedBytes + itemBytes,
          removed.length + 1,
          escapedPartsBytes,
          escapedRemovedBytes + escapedItemBytes,
        ),
      )
    ) {
      if (parts.length === 0 && removed.length === 0) {
        throw new Error("A legacy removed item id exceeds the delivery byte limit.");
      }
      break;
    }
    removed.push(itemId);
    removedBytes += itemBytes;
    escapedRemovedBytes += escapedItemBytes;
    removedIndex += 1;
  }
  const done = document >= source.documents.length && removedIndex >= source.removed.length;
  const delivery: SearchDelivery = {
    ...source,
    thread,
    deliveryId,
    documents: [],
    parts,
    removed,
    complete: done && source.complete,
  };
  const encoded = encodeDelivery(delivery);
  if (
    utf8Bytes(encoded) > SEARCH_DELIVERY_MAX_BYTES ||
    searchDeliveryRowBytes(source.revision, rowPage, deliveryId, encoded) >
      SEARCH_DELIVERY_MAX_BYTES
  ) {
    throw new Error("A converted search delivery exceeds the byte limit.");
  }
  return {
    delivery,
    cursor: { document, offset, removed: removedIndex },
    done,
  };
};
