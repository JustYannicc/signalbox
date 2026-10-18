import * as NodeUtil from "node:util";

// Bun ignores missing undefined properties and trailing undefined array entries unless strict.
function comparable(value: unknown, strict: boolean, seen: WeakMap<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    let length = value.length;
    if (!strict) while (length > 0 && value[length - 1] === undefined) length--;
    for (let index = 0; index < length; index++)
      result.push(comparable(value[index], strict, seen));
    return result;
  }
  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    seen.set(value, result);
    for (const [key, entry] of value)
      result.set(comparable(key, strict, seen), comparable(entry, strict, seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set<unknown>();
    seen.set(value, result);
    for (const entry of value) result.add(comparable(entry, strict, seen));
    return result;
  }
  if (Object.prototype.toString.call(value) !== "[object Object]") return value;
  const result: Record<PropertyKey, unknown> = {};
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
    const entry: unknown = Reflect.get(value, key);
    if (strict || entry !== undefined) {
      Object.defineProperty(result, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: comparable(entry, strict, seen),
      });
    }
  }
  return result;
}

export function deepEquals(left: unknown, right: unknown, strict = false): boolean {
  return NodeUtil.isDeepStrictEqual(
    comparable(left, strict, new WeakMap()),
    comparable(right, strict, new WeakMap()),
  );
}
