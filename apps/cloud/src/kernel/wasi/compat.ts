// Node's private validators/errors are unavailable to a userland workerd carry.
export class ERR_INVALID_ARG_TYPE extends TypeError {
  readonly code = "ERR_INVALID_ARG_TYPE";
  constructor(name: string, expected: string, _value: unknown) {
    super(`${name} must be ${expected}`);
  }
}

export class ERR_INVALID_ARG_VALUE extends TypeError {
  readonly code = "ERR_INVALID_ARG_VALUE";
  constructor(name: string, _value: unknown, reason = "has an invalid value") {
    super(`${name} ${reason}`);
  }
}

export class ERR_METHOD_NOT_IMPLEMENTED extends Error {
  readonly code = "ERR_METHOD_NOT_IMPLEMENTED";
  constructor(name: string) {
    super(`${name} is not implemented`);
  }
}

export function validateObject(value: unknown, name: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "an object", value);
  }
}

export function validateArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, "an array", value);
}

export function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "a boolean", value);
}

export function validateOneOf(value: unknown, name: string, allowed: readonly unknown[]) {
  if (!allowed.includes(value)) throw new ERR_INVALID_ARG_VALUE(name, value);
}

export function validateInt32(value: unknown, name: string, minimum = -0x80000000) {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "a number", value);
  if (!Number.isInteger(value) || value < minimum || value > 0x7fffffff) {
    throw Object.assign(new RangeError(`${name} must be an integer in [${minimum}, 2147483647]`), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
}
