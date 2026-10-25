import { NodeGeneratedCodeInputError } from "./errors.ts";

const stringify = JSON.stringify;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const objectPrototype = Object.prototype;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const getOwnPropertyNames = Object.getOwnPropertyNames;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const setPrototypeOf = Reflect.setPrototypeOf;
const stringOf = String;
const numberOf = Number;
const numberIsInteger = Number.isInteger;

/** Nimbus's runtimeFunctionModule argument kinds, kept outside its TS closure. */
export type NodeGeneratedFunctionKind = "function" | "async" | "generator" | "asyncGenerator";

export interface NodeGeneratedFunctionCode {
  readonly kind: NodeGeneratedFunctionKind;
  readonly params: readonly string[];
  readonly body: string;
}

/**
 * Prepared Nimbus boundary. NodeVmBuild supplies runtimeFunctionModule from a
 * CJS bundle of the pinned Nimbus commonjs-cell implementation; importing its
 * TypeScript source here would pull the excluded upstream compiler closure in.
 */
export interface NodeGeneratedFunctionModuleRuntime {
  runtimeFunctionModule(
    kind: NodeGeneratedFunctionKind,
    params: readonly string[],
    body: string,
  ): string;
}

/** Nimbus's exact sync identity source, used by next-boot constructor lookup. */
export function nodeGeneratedFunctionSourceKey(entry: NodeGeneratedFunctionCode): string {
  // Match Nimbus's JSON tuple without invoking guest array toJSON hooks.
  let params = "";
  for (let index = 0; index < entry.params.length; index++) {
    if (index > 0) params += ",";
    params += stringify(entry.params[index]);
  }
  return `[${stringify(entry.kind)},[${params}],${stringify(entry.body)}]`;
}

export function normalizeNodeGeneratedFunctionCode(entry: unknown): NodeGeneratedFunctionCode {
  if (typeof entry !== "object" || entry === null || arrayIsArray(entry)) {
    throw new NodeGeneratedCodeInputError("Generated-code function entry is invalid");
  }
  const prototype = getPrototypeOf(entry);
  if (prototype !== objectPrototype && prototype !== null) {
    throw new NodeGeneratedCodeInputError("Generated-code function entry must be a plain record");
  }
  if (getOwnPropertySymbols(entry).length > 0) {
    throw new NodeGeneratedCodeInputError("Generated-code function entry cannot have symbol keys");
  }
  const fields = getOwnPropertyNames(entry);
  if (fields.length !== 3) {
    throw new NodeGeneratedCodeInputError(
      "Generated-code function entry must contain only kind, params, and body",
    );
  }
  const kind = ownDataValue(entry, "kind");
  const rawParams = ownDataValue(entry, "params");
  const body = ownDataValue(entry, "body");
  if (
    (kind !== "function" &&
      kind !== "async" &&
      kind !== "generator" &&
      kind !== "asyncGenerator") ||
    !arrayIsArray(rawParams) ||
    typeof body !== "string" ||
    getOwnPropertySymbols(rawParams).length > 0
  ) {
    throw new NodeGeneratedCodeInputError("Generated-code function entry is invalid");
  }
  const params: string[] = [];
  setPrototypeOf(params, null);
  for (let index = 0; index < rawParams.length; index++) {
    const parameter = ownDataValue(rawParams, stringOf(index));
    if (typeof parameter !== "string") {
      throw new NodeGeneratedCodeInputError("Generated-code function parameters must be strings");
    }
    params[index] = parameter;
  }
  const keys = getOwnPropertyNames(rawParams);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (key !== "length" && !isArrayIndex(key, rawParams.length)) {
      throw new NodeGeneratedCodeInputError(
        "Generated-code function parameters must be a plain array",
      );
    }
  }
  setPrototypeOf(params, arrayPrototype);
  return { kind, params, body };
}

export function runtimeCodeModuleName(key: string): string {
  return `gen/${key}.js`;
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new NodeGeneratedCodeInputError(
      "Generated-code function entry cannot contain missing fields or accessors",
    );
  }
  return descriptor.value;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = numberOf(key);
  return numberIsInteger(index) && index >= 0 && index < length && stringOf(index) === key;
}
