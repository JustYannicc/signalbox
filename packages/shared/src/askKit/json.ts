import {
  ASK_KIT_JSON_MAX_DEPTH,
  ASK_KIT_JSON_MAX_LENGTH,
  type AskKitProblem,
  type AskKitProblemCode,
} from "@t3tools/contracts/askKit";

export type Path = ReadonlyArray<string | number>;

export const problem = (code: AskKitProblemCode, path: Path, message: string): AskKitProblem => ({
  code,
  path: [...path],
  message,
});

const isPlainObject = (node: object) => {
  const prototype = Object.getPrototypeOf(node);
  return prototype === Object.prototype || prototype === null;
};

export type CanonicalJson =
  | { readonly key: string }
  | { readonly failure: "not-json" | "too-deep" | "too-large" };

/** Key order is sorted so equal JSON compares equal, which option matching relies on. */
export function canonicalJson(value: unknown): CanonicalJson {
  let failure: "not-json" | "too-deep" | null = null;
  const walk = (node: unknown, depth: number): string => {
    if (failure !== null) return "";
    if (depth > ASK_KIT_JSON_MAX_DEPTH) {
      failure = "too-deep";
      return "";
    }
    if (node === null || typeof node === "boolean" || typeof node === "string") {
      return JSON.stringify(node);
    }
    if (typeof node === "number" && Number.isFinite(node)) return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map((item) => walk(item, depth + 1)).join(",")}]`;
    if (typeof node === "object" && isPlainObject(node)) {
      const record = node as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${walk(record[key], depth + 1)}`);
      return `{${entries.join(",")}}`;
    }
    failure = "not-json";
    return "";
  };
  const key = walk(value, 0);
  if (failure !== null) return { failure };
  return key.length > ASK_KIT_JSON_MAX_LENGTH ? { failure: "too-large" } : { key };
}

/**
 * Whether a value is JSON at all, with no size or depth bound: legacy surfaces accept whatever
 * the ask contract does. Iterative, so a deeply nested value can't exhaust the stack.
 */
export function isJsonValue(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node === "boolean" || typeof node === "string") continue;
    if (typeof node === "number" && Number.isFinite(node)) continue;
    if (Array.isArray(node)) for (const item of node) pending.push(item);
    else if (typeof node === "object" && isPlainObject(node)) {
      for (const item of Object.values(node)) pending.push(item);
    } else return false;
  }
  return true;
}

export function jsonProblem(failure: "not-json" | "too-deep" | "too-large", path: Path) {
  return failure === "not-json"
    ? problem("json-invalid", path, "Not a JSON value.")
    : problem("json-too-large", path, "The JSON value is too large or nested too deeply.");
}

/**
 * Kit components name options by value, so values must be distinct bounded JSON, and `null`
 * stays free to mean a words-only answer.
 */
export function kitOptionIndex(
  options: ReadonlyArray<{ readonly value: unknown }>,
  problems: AskKitProblem[],
): Map<string, number> {
  const index = new Map<string, number>();
  options.forEach((option, position) => {
    const path = ["options", position, "value"];
    const json = canonicalJson(option.value);
    if ("failure" in json) problems.push(jsonProblem(json.failure, path));
    else if (option.value === null) {
      problems.push(problem("option-value-null", path, "null is reserved for words-only answers."));
    } else if (index.has(json.key)) {
      problems.push(problem("option-values-repeated", path, "Another option has the same value."));
    } else index.set(json.key, position);
  });
  return index;
}
