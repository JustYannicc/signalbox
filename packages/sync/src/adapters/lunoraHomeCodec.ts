import * as Schema from "effect/Schema";
import { SyncCursor, SyncFailure, type SyncSchema } from "../definition.ts";
import { canonicalJson, encodeWireValue, decodeWireValue } from "./lunoraWireValue.ts";

export type RuntimeSchema = SyncSchema;

const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
export function decodeJson(value: string) {
  try {
    return parseJson(value);
  } catch {
    throw new SyncFailure({ reason: "storage_corrupt" });
  }
}
const decoders = new WeakMap<Schema.Constraint, (value: unknown) => unknown>();

export function decode<S extends Schema.Constraint>(
  schema: S,
  value: unknown,
  reason: "invalid_input" | "unavailable",
): S["Type"] {
  try {
    let parser = decoders.get(schema);
    if (parser === undefined) {
      parser = Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" });
      decoders.set(schema, parser);
    }
    // The cache entry was compiled from this exact schema.
    return parser(value) as S["Type"];
  } catch {
    throw new SyncFailure({ reason });
  }
}

export async function encodeWire<S extends RuntimeSchema>(
  schema: S,
  value: unknown,
  reason: "invalid_input" | "unavailable",
): Promise<S["Encoded"]> {
  try {
    const encoded = await Schema.encodeUnknownPromise(schema)(value);
    if (encoded !== undefined) canonicalJson(encoded);
    return encoded;
  } catch {
    throw new SyncFailure({ reason });
  }
}

export const encode = encodeWireValue;

export const decodeStored = <S extends RuntimeSchema>(
  schema: S,
  value: unknown,
): Promise<S["Type"]> => decodeWireValue(schema, value, "storage_corrupt");

const Cursor = Schema.fromJsonString(
  Schema.Struct({ binding: Schema.String, authorization: Schema.String }),
);
const decodeCursor = Schema.decodeSync(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The cursor permits fresh re-evaluation only; it never grants access to cached output. */
export async function makeCursor(
  binding: readonly unknown[],
  authorization: string,
  resume?: SyncCursor,
): Promise<SyncCursor> {
  const marker = await digest(canonicalJson(binding));
  if (resume !== undefined) {
    try {
      if (decodeCursor(resume).binding !== marker) throw new Error("Cursor binding changed");
    } catch {
      throw new SyncFailure({ reason: "invalid_cursor" });
    }
  }
  return SyncCursor.make(
    encodeCursor({ binding: marker, authorization: await digest(authorization) }),
  );
}
