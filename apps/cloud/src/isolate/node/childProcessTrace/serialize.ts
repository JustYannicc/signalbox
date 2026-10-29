const maxDepth = 16;
const maxValues = 512;
const maxProperties = 256;
const maxStringLength = 65_536;

export type SerializedTraceValue = Readonly<Record<string, unknown>>;

interface SerializationState {
  readonly ids: WeakMap<object, number>;
  nextId: number;
  values: number;
}

export function serializeNodeTraceValue(value: unknown): SerializedTraceValue {
  return serialize(value, { ids: new WeakMap(), nextId: 1, values: 0 }, 0);
}

export const serializeTraceValue = serializeNodeTraceValue;

export function serializeTraceArgs(args: readonly unknown[]): readonly SerializedTraceValue[] {
  const state: SerializationState = { ids: new WeakMap(), nextId: 1, values: 0 };
  return args.map((value) => serialize(value, state, 0));
}

function serialize(value: unknown, state: SerializationState, depth: number): SerializedTraceValue {
  state.values += 1;
  if (state.values > maxValues) return gap("value-limit");
  if (depth > maxDepth) return gap("depth-limit");

  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  if (typeof value === "string") {
    return value.length > maxStringLength
      ? { kind: "uncapturable", reason: "string-limit", length: value.length }
      : { kind: "string", value };
  }
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", value }
      : { kind: "number", value: String(value) };
  }
  if (typeof value === "bigint") return { kind: "bigint", value: value.toString() };
  if (typeof value === "symbol") {
    return { kind: "uncapturable", reason: "symbol", description: value.description ?? null };
  }
  if (typeof value === "function") return { kind: "uncapturable", reason: "function" };

  const priorId = state.ids.get(value);
  if (priorId !== undefined) return { kind: "reference", id: priorId };
  const id = state.nextId++;
  state.ids.set(value, id);

  if (Array.isArray(value)) return serializeArray(value, state, depth, id);
  if (value instanceof Error) return serializeError(value, state, depth, id);
  return serializeObject(value, state, depth, id);
}

function serializeArray(
  value: readonly unknown[],
  state: SerializationState,
  depth: number,
  id: number,
): SerializedTraceValue {
  const items: SerializedTraceValue[] = [];
  const count = Math.min(value.length, maxProperties);
  for (let index = 0; index < count; index += 1) {
    if (!(index in value)) {
      items.push({ kind: "absent" });
      continue;
    }
    let item: unknown;
    try {
      item = value[index];
    } catch {
      items.push(gap("array-read-failed", index));
      continue;
    }
    items.push(serialize(item, state, depth + 1));
  }
  const extra = ownProperties(
    value,
    state,
    depth,
    new Set(["length", ...items.map((_, i) => String(i))]),
  );
  return {
    kind: "array",
    id,
    items,
    ...(value.length > count ? { uncapturedItems: value.length - count } : {}),
    ...extra,
  };
}

function serializeError(
  error: Error,
  state: SerializationState,
  depth: number,
  id: number,
): SerializedTraceValue {
  const standard = [
    "name",
    "message",
    "code",
    "errno",
    "syscall",
    "path",
    "spawnargs",
    "stack",
    "cause",
  ];
  const fields: Record<string, unknown> = {};
  for (const key of standard) fields[key] = errorField(error, key, state, depth);
  return {
    kind: "error",
    id,
    fields,
    ...ownProperties(error, state, depth, new Set(standard)),
  };
}

function errorField(
  error: Error,
  key: string,
  state: SerializationState,
  depth: number,
): SerializedTraceValue {
  let present: boolean;
  let own: boolean;
  try {
    present = key in error;
    own = Object.prototype.hasOwnProperty.call(error, key);
  } catch {
    return { present: true, own: false, value: gap("error-field-check-failed") };
  }
  if (!present) return { present: false, own: false };
  try {
    return {
      present: true,
      own,
      value: serialize(Reflect.get(error, key), state, depth + 1),
    };
  } catch {
    return { present: true, own, value: gap("error-field-read-failed") };
  }
}

function serializeObject(
  value: object,
  state: SerializationState,
  depth: number,
  id: number,
): SerializedTraceValue {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return { kind: "object", id, properties: {}, gap: "prototype-read-failed" };
  }
  return {
    kind: "object",
    id,
    prototype: prototypeName(prototype),
    ...ownProperties(value, state, depth, new Set()),
  };
}

function ownProperties(
  value: object,
  state: SerializationState,
  depth: number,
  excluded: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  let names: string[];
  let symbols: symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return { properties: {}, gap: "property-list-failed" };
  }

  const properties: Record<string, SerializedTraceValue> = {};
  let included = 0;
  for (const name of names) {
    if (excluded.has(name)) continue;
    if (included >= maxProperties) break;
    included += 1;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      properties[name] = gap("property-descriptor-failed");
      continue;
    }
    if (descriptor === undefined) {
      properties[name] = gap("property-disappeared");
    } else if (!("value" in descriptor)) {
      properties[name] = gap("accessor-not-invoked");
    } else {
      properties[name] = serialize(descriptor.value, state, depth + 1);
    }
  }

  const omittedProperties = Math.max(
    0,
    names.filter((name) => !excluded.has(name)).length - included,
  );
  return {
    properties,
    ...(omittedProperties > 0 ? { uncapturedProperties: omittedProperties } : {}),
    ...(symbols.length > 0
      ? { uncapturedSymbolProperties: symbols.map((symbol) => symbol.description ?? "") }
      : {}),
  };
}

function prototypeName(prototype: object | null): string | null {
  if (prototype === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    const constructor = descriptor !== undefined && "value" in descriptor ? descriptor.value : null;
    if (typeof constructor !== "function") return null;
    return typeof constructor.name === "string" ? constructor.name : null;
  } catch {
    return null;
  }
}

function gap(reason: string, index?: number): SerializedTraceValue {
  return { kind: "uncapturable", reason, ...(index === undefined ? {} : { index }) };
}
