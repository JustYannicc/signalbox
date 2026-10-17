import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const isOwnJson = (input: unknown, parents = new Set<object>()): input is Schema.Json => {
  if (input === null || typeof input === "string" || typeof input === "boolean") return true;
  if (typeof input === "number") return Number.isFinite(input);
  if (typeof input !== "object" || parents.has(input)) return false;
  const array = Array.isArray(input);
  const prototype = Object.getPrototypeOf(input);
  if (
    array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(input);
  if (array && keys.length !== input.length + 1) return false;
  if (array) {
    for (let index = 0; index < input.length; index++) {
      if (!Object.hasOwn(input, index)) return false;
    }
  }
  parents.add(input);
  const valid = keys.every((key) => {
    if (array && key === "length") return true;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      "value" in descriptor &&
      isOwnJson(descriptor.value, parents)
    );
  });
  parents.delete(input);
  return valid;
};

// Check before codecs can strip unknown fields or read inherited properties/getters.
export const OwnJson = Schema.declare<Schema.Json>(isOwnJson);

// v4 parse options belong to decoders, so enforce strict writes inside the schema too.
export const strictJsonCodec = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
    reportInput: false,
  });
  return OwnJson.check(Schema.makeFilter((input) => Result.isSuccess(decode(input)))).pipe(
    Schema.decodeTo(schema),
  );
};

export const isJsonRecord = (input: Schema.Json | undefined): input is Schema.JsonObject =>
  input !== undefined && input !== null && typeof input === "object" && !Array.isArray(input);

export const isStoredRecord = (input: unknown): input is Schema.JsonObject =>
  isOwnJson(input) && isJsonRecord(input);

export const mergeLocalJson = (base: Schema.Json | undefined, patch: Schema.Json): Schema.Json => {
  if (Array.isArray(patch)) return patch.map((value) => mergeLocalJson(undefined, value));
  if (!isJsonRecord(patch)) return patch;
  const previous: Schema.JsonObject = isJsonRecord(base) ? base : {};
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    Object.defineProperty(next, key, {
      value: mergeLocalJson(Object.hasOwn(previous, key) ? previous[key] : undefined, value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return next;
};

export const equalJson = (
  left: Schema.Json | undefined,
  right: Schema.Json | undefined,
): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
    );
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
  );
};
