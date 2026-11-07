import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import type ZStream from "pako/lib/zlib/zstream.js";
import type { PakoArray } from "pako/lib/zlib/zstream.js";
import {
  arrayFields,
  INFLATE_FORMAT,
  InflateScalars,
  type InflateCheckpoint,
} from "./inflateState.ts";

const scalarFields = Object.keys(InflateScalars.fields) as Array<keyof InflateScalars>;

const encodeArray = (array: PakoArray) => {
  const bytes = new Uint8Array(array.byteLength);
  const view = new DataView(bytes.buffer);
  const type = array instanceof Uint8Array ? "u8" : array instanceof Uint16Array ? "u16" : "i32";
  for (let index = 0; index < array.length; index++) {
    const value = array[index]!;
    if (type === "u8") view.setUint8(index, value);
    else if (type === "u16") view.setUint16(index * 2, value, true);
    else view.setInt32(index * 4, value, true);
  }
  return { type, data: Base64.encode(bytes) } as const;
};

export const saveCheckpoint = (stream: ZStream, expectedSize: number) => {
  const state = stream.state;
  if (state === null || state.strm !== stream || state.head !== null || state.next !== null) {
    throw new Error("Unsupported inflater state");
  }
  const arrays: Array<ReturnType<typeof encodeArray> | null> = [];
  const identities = new Map<PakoArray, number>();
  const refs = Object.fromEntries(
    arrayFields.map((field) => {
      const array = state[field];
      if (array === null) return [field, null];
      let reference = identities.get(array);
      if (reference === undefined) {
        reference = arrays.length;
        identities.set(array, reference);
        arrays.push(encodeArray(array));
      }
      return [field, reference];
    }),
  );
  while (arrays.length < 7) arrays.push(null);
  return {
    format: INFLATE_FORMAT,
    expectedSize,
    sourceOffset: stream.total_in,
    expandedOffset: stream.total_out,
    stream: { data_type: stream.data_type, adler: stream.adler },
    state: Object.fromEntries(scalarFields.map((field) => [field, state[field]])),
    refs,
    arrays,
  };
};

const decodeArray = (array: NonNullable<InflateCheckpoint["arrays"][number]>) => {
  const decoded = Base64.decode(array.data);
  if (Result.isFailure(decoded)) throw decoded.failure;
  const bytes = decoded.success;
  // Reject noncanonical or oversized data before allocating typed state.
  if (Base64.encode(bytes) !== array.data) throw new Error("Invalid checkpoint bytes");
  const width = array.type === "u8" ? 1 : array.type === "u16" ? 2 : 4;
  if (bytes.length % width !== 0) throw new Error("Invalid checkpoint alignment");
  const result =
    array.type === "u8"
      ? new Uint8Array(bytes.length)
      : array.type === "u16"
        ? new Uint16Array(bytes.length / 2)
        : new Int32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < result.length; index++) {
    result[index] =
      width === 1
        ? view.getUint8(index)
        : width === 2
          ? view.getUint16(index * 2, true)
          : view.getInt32(index * 4, true);
  }
  return result;
};

// Pako trusts its own tables. A persisted zero-bit match or invalid subtable
// must never turn one bounded step into a loop without input/output progress.
const validateTable = (
  table: PakoArray,
  rootBits: number,
  kind: "codes" | "length" | "distance",
) => {
  const rootSize = 1 << rootBits;
  if (rootBits < 1 || rootSize > table.length) throw new Error("Invalid checkpoint table root");
  const terminal = (entry: number, maximumBits: number) => {
    const bits = entry >>> 24;
    const operation = (entry >>> 16) & 255;
    const value = entry & 65535;
    if (bits < 1 || bits > maximumBits) throw new Error("Invalid checkpoint code bits");
    if (kind === "codes") {
      if (operation !== 0 || value > 18) throw new Error("Invalid checkpoint length code");
    } else if (operation === 0) {
      if (kind !== "length" || value > 255) throw new Error("Invalid checkpoint literal");
    } else if ((operation & 64) !== 0) {
      // Invalid-code and end-of-block markers terminate rather than loop.
    } else if (
      (operation & 16) === 0 ||
      (operation & 224) !== 0 ||
      value < (kind === "length" ? 3 : 1) ||
      value > (kind === "length" ? 258 : 32768)
    ) {
      throw new Error("Invalid checkpoint match");
    }
  };
  const checked = new Set<number>();
  for (let index = 0; index < rootSize; index++) {
    const entry = table[index]!;
    const operation = (entry >>> 16) & 255;
    if (operation === 0 || operation >= 16) {
      terminal(entry, rootBits);
      continue;
    }
    const start = entry & 65535;
    const size = 1 << operation;
    if (
      kind === "codes" ||
      entry >>> 24 !== rootBits ||
      start < rootSize ||
      start + size > table.length
    ) {
      throw new Error("Invalid checkpoint subtable");
    }
    // Repeated root pointers must not multiply validation work.
    for (let child = start; child < start + size; child++) {
      if (!checked.has(child)) {
        terminal(table[child]!, operation);
        checked.add(child);
      }
    }
  }
};

export const restoreCheckpoint = (stream: ZStream, checkpoint: InflateCheckpoint) => {
  const state = stream.state;
  if (state === null) throw new Error("Inflater was not initialized");
  const arrays = checkpoint.arrays.map((array) => (array === null ? null : decodeArray(array)));
  const refs = checkpoint.refs;
  const get = (field: (typeof arrayFields)[number]) => {
    const reference = refs[field];
    return reference === null ? null : (arrays[reference] ?? null);
  };
  const valid = (
    field: (typeof arrayFields)[number],
    type: string,
    lengths: ReadonlyArray<number>,
  ) => {
    const array = get(field);
    if (array === null || array.constructor.name !== type || !lengths.includes(array.length)) {
      throw new Error("Invalid checkpoint array");
    }
  };
  if (refs.window !== null) valid("window", "Uint8Array", [32768]);
  valid("lens", "Uint16Array", [320]);
  valid("work", "Uint16Array", [288]);
  valid("lendyn", "Int32Array", [852]);
  valid("distdyn", "Int32Array", [592]);
  valid("lencode", "Int32Array", refs.lencode === refs.lendyn ? [852] : [512]);
  valid("distcode", "Int32Array", refs.distcode === refs.distdyn ? [592] : [32]);
  const liveRefs = arrayFields.flatMap((field) => (refs[field] === null ? [] : [refs[field]]));
  const unique = new Set(liveRefs);
  if (
    unique.size !==
      (refs.window === null ? 4 : 5) +
        Number(refs.lencode !== refs.lendyn) +
        Number(refs.distcode !== refs.distdyn) ||
    arrays.some((array, index) => (array !== null) !== unique.has(index)) ||
    (checkpoint.state.wsize === 0) !== (refs.window === null) ||
    checkpoint.state.whave > checkpoint.state.wsize ||
    (checkpoint.state.wsize === 0 && checkpoint.state.wnext !== 0)
  ) {
    throw new Error("Invalid checkpoint references or dictionary");
  }
  if (get("lens")!.some((value) => value > 15) || get("work")!.some((value) => value > 287)) {
    throw new Error("Invalid checkpoint code lengths");
  }
  const saved = checkpoint.state;
  // MATCH uses a do/while copy, so zero remaining length would never finish.
  if (
    (saved.mode >= 16201 &&
      saved.mode <= 16204 &&
      (saved.length < (saved.mode === 16204 ? 1 : 3) || saved.length > 258)) ||
    (saved.mode >= 16203 && saved.mode <= 16204 && saved.offset < 1) ||
    (saved.mode === 16201 && saved.extra > 5) ||
    (saved.mode === 16203 && saved.extra > 13) ||
    (saved.mode === 16205 && saved.length > 255)
  ) {
    throw new Error("Invalid checkpoint pending match");
  }
  if (saved.mode === 16197 || saved.mode === 16198) {
    if (
      saved.nlen < 257 ||
      saved.ndist < 1 ||
      saved.ncode < 4 ||
      saved.have > saved.nlen + saved.ndist
    ) {
      throw new Error("Invalid checkpoint table construction");
    }
  }
  if (saved.mode === 16198) validateTable(get("lencode")!, saved.lenbits, "codes");
  if (saved.mode >= 16199 && saved.mode <= 16205) {
    validateTable(get("lencode")!, saved.lenbits, "length");
    validateTable(get("distcode")!, saved.distbits, "distance");
  }
  stream.total_in = checkpoint.sourceOffset;
  stream.total_out = checkpoint.expandedOffset;
  Object.assign(stream, checkpoint.stream);
  for (const field of scalarFields) state[field] = checkpoint.state[field];
  for (const field of arrayFields) state[field] = get(field);
  state.strm = stream;
};
