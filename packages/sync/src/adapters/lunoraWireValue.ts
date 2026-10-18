import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import type * as SchemaAST from "effect/SchemaAST";
import { SyncFailure, type SyncSchema } from "../definition.ts";

/** JSON has no undefined value. The tag preserves it without conflating it with null. */
type WireValueAbsent<Encoded> = undefined extends Encoded
  ? { readonly defined: false }
  : void extends Encoded
    ? { readonly defined: false }
    : never;

/** Native Lunora validators return mutable arrays even when Effect encodes them readonly. */
type MutableWireJson<Value> = Value extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? Value
  : Value extends readonly unknown[]
    ? { -readonly [Index in keyof Value]: MutableWireJson<Value[Index]> }
    : Value extends object
      ? { readonly [Key in keyof Value]: MutableWireJson<Value[Key]> }
      : Value;

type WireValuePresent<Encoded> =
  Exclude<Encoded, undefined | void> extends infer Present
    ? [Present] extends [never]
      ? never
      : { readonly defined: true; readonly value: MutableWireJson<Present> }
    : never;

export type WireValue<S extends SyncSchema> =
  | WireValueAbsent<S["Encoded"]>
  | WireValuePresent<S["Encoded"]>;

function members(ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> {
  return ast._tag === "Union" ? ast.types : [ast];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Schema validation runs first; this copies its JSON result into arrays Lunora can mutate. */
function cloneMutableWireJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMutableWireJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneMutableWireJson(item)]),
    );
  }
  return value;
}

function acceptsAbsent(ast: SchemaAST.AST): boolean {
  return (
    ast._tag === "Undefined" || ast._tag === "Void" || ast._tag === "Unknown" || ast._tag === "Any"
  );
}

function acceptsPresent(ast: SchemaAST.AST): boolean {
  return ast._tag !== "Undefined" && ast._tag !== "Void" && ast._tag !== "Never";
}

/** Canonical JSON keeps object insertion order out of replay identity. */
export function canonicalJson(value: unknown, omitUndefinedObjectProperties = true): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value, (item) => canonicalJson(item, omitUndefinedObjectProperties)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => !omitUndefinedObjectProperties || item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, omitUndefinedObjectProperties)}`,
      )
      .join(",")}}`;
  }
  throw new SyncFailure({ reason: "invalid_input" });
}

function isPresentJson(value: unknown): boolean {
  try {
    canonicalJson(value, false);
    return true;
  } catch {
    return false;
  }
}

export function wireValueSchema<S extends SyncSchema>(schema: S): Schema.Codec<WireValue<S>> {
  const encoded: Schema.Codec<S["Encoded"]> = Schema.toEncoded(schema);
  const ast = encoded.ast;
  const possible = members(ast);
  const variants = [
    ...(possible.some(acceptsAbsent) ? [Schema.Struct({ defined: Schema.Literal(false) })] : []),
    ...(possible.some(acceptsPresent)
      ? [Schema.Struct({ defined: Schema.Literal(true), value: encoded })]
      : []),
  ];
  if (variants.length === 0) return Schema.Never as Schema.Codec<WireValue<S>>;
  const envelope = (
    variants.length === 1 ? variants[0]! : Schema.Union(variants as never)
  ) as Schema.Codec<WireValue<S>>;
  return envelope.check(
    Schema.makeFilter<WireValue<S>>(
      (wire) => !wire.defined || isPresentJson("value" in wire ? wire.value : undefined),
    ),
  );
}

/** Validates an already encoded wire envelope and refines its absent/present branch from the schema. */
export async function validateWireValue<S extends SyncSchema>(
  schema: S,
  wire: unknown,
  reason: SyncFailure["reason"] = "unavailable",
): Promise<WireValue<S>> {
  try {
    const decoded = await Schema.decodeUnknownPromise(wireValueSchema(schema), {
      onExcessProperty: "error",
    })(wire);
    return cloneMutableWireJson(decoded) as WireValue<S>;
  } catch {
    throw new SyncFailure({ reason });
  }
}

export function wireValueCodec<S extends SyncSchema>(
  schema: S,
): Schema.Codec<S["Type"], WireValue<S>> {
  return wireValueSchema(schema).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((wire) => (wire.defined ? wire.value : undefined)),
      encode: SchemaGetter.transform(
        (value) =>
          cloneMutableWireJson(
            value === undefined ? { defined: false as const } : { defined: true as const, value },
          ) as WireValue<S>,
      ),
    }),
  );
}

export async function encodeWireValue<S extends SyncSchema>(
  schema: S,
  value: S["Type"],
  reason: SyncFailure["reason"] = "unavailable",
): Promise<WireValue<S>> {
  try {
    return await Schema.encodePromise(wireValueCodec(schema))(value);
  } catch {
    throw new SyncFailure({ reason });
  }
}

export async function decodeWireValue<S extends SyncSchema>(
  schema: S,
  value: unknown,
  reason: SyncFailure["reason"] = "unavailable",
): Promise<S["Type"]> {
  try {
    return await Schema.decodeUnknownPromise(wireValueCodec(schema), { onExcessProperty: "error" })(
      value,
    );
  } catch {
    throw new SyncFailure({ reason });
  }
}
