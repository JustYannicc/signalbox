import { NodeGeneratedCodeInputError } from "./errors.ts";
import { generatedCodePromise } from "./generation-realm.ts";
import { hashSha256Bytes } from "./vendor/noble/sha256.mjs";

export type NodeGeneratedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NodeGeneratedJsonValue[]
  | { readonly [key: string]: NodeGeneratedJsonValue };

export interface NodeGeneratedCodeInvokeInput {
  /** A caller label, not a content hash. Uses the host's ASCII letter/digit/hyphen grammar. */
  readonly id: string;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly input: NodeGeneratedJsonValue;
}

export interface ValidatedNodeGeneratedCodeInvokeInput {
  readonly id: string;
  readonly mainModule: string;
  readonly entries: readonly (readonly [name: string, source: string])[];
  readonly inputJson: string;
}

export const NODE_GENERATED_CODE_CALLER_ID_MAX_BYTES = 100;

const encoder = new TextEncoder();
const encode = encoder.encode.bind(encoder);
const apply = Reflect.apply;
const Uint8ArrayOf = Uint8Array;
const hexDigits = "0123456789abcdef";
const typedArrayPrototype = Object.getPrototypeOf(Uint8ArrayOf.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const moduleSegment = /^[A-Za-z0-9_@+.-]+$/u;
const moduleBase = "https://node-generated.invalid/";

export function validateNodeGeneratedCodeInvokeInput(
  input: NodeGeneratedCodeInvokeInput,
): ValidatedNodeGeneratedCodeInvokeInput {
  const fields = readRequestFields(input);
  if (typeof fields.id !== "string" || fields.id.length === 0) {
    throw new NodeGeneratedCodeInputError("Generated-code caller id must be a non-empty string");
  }
  if (generatedCodeUtf8ByteLength(fields.id) > NODE_GENERATED_CODE_CALLER_ID_MAX_BYTES) {
    throw new NodeGeneratedCodeInputError(
      `Generated-code caller id exceeds ${NODE_GENERATED_CODE_CALLER_ID_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (!/^[a-zA-Z0-9-]+$/.test(fields.id)) {
    throw new NodeGeneratedCodeInputError(
      "Generated-code caller id must contain only ASCII letters, digits, and hyphens",
    );
  }

  const entries = validateModuleMap(fields.modules);
  validateModuleName(fields.mainModule);
  if (!entries.some(([name]) => name === fields.mainModule)) {
    throw new NodeGeneratedCodeInputError(
      "Generated-code mainModule must name a module in modules",
    );
  }
  const id = fields.id;
  const mainModule = fields.mainModule;

  return {
    id,
    mainModule,
    entries,
    inputJson: serializeJson(fields.input),
  };
}

export function nodeGeneratedCodeInvokeBody(input: ValidatedNodeGeneratedCodeInvokeInput): string {
  const moduleFields = input.entries
    .map(([name, source]) => `${quote(name)}:${quote(source)}`)
    .join(",");
  return `{"id":${quote(input.id)},"mainModule":${quote(input.mainModule)},"modules":{${moduleFields}},"input":${input.inputJson}}`;
}

/** Hashes exact UTF-8 module graph bytes with length framing, independent of object insertion order. */
export function nodeGeneratedModuleGraphDigest(
  mainModule: string,
  modules: Readonly<Record<string, string>>,
): Promise<string> {
  return generatedCodePromise(
    (async () => {
      validateModuleName(mainModule);
      const entries = validateModuleMap(modules);
      if (!entries.some(([name]) => name === mainModule)) {
        throw new NodeGeneratedCodeInputError(
          "Generated-code mainModule must name a module in modules",
        );
      }

      const fields = [mainModule, ...entries.flatMap(([name, source]) => [name, source])];
      const encoded = fields.map((field) => encode(quote(field)));
      let size = 0;
      for (const field of encoded) size += 8 + byteLengthOf(field);
      const framed = new Uint8Array(size);
      const view = new DataView(framed.buffer);
      let offset = 0;
      for (const field of encoded) {
        const length = byteLengthOf(field);
        view.setBigUint64(offset, BigInt(length));
        offset += 8;
        framed.set(field, offset);
        offset += length;
      }

      return sha256Hex(framed);
    })(),
  );
}

export function generatedCodeUtf8ByteLength(value: string): number {
  return byteLengthOf(encode(value));
}

function byteLengthOf(value: Uint8Array): number {
  if (!typedArrayByteLength) {
    throw new NodeGeneratedCodeInputError("Typed array byte-length intrinsic is unavailable");
  }
  return apply(typedArrayByteLength, value, []) as number;
}

export function sha256Hex(value: string | Uint8Array): Promise<string> {
  return generatedCodePromise(
    (async () => {
      const bytes = typeof value === "string" ? encode(value) : new Uint8ArrayOf(value);
      // WebCrypto resolves a guest-visible ArrayBuffer; workerd's node:crypto
      // constructs a stream through mutable reflection. Keep this operation synchronous.
      const digest = hashSha256Bytes(bytes);
      let hex = "";
      for (let index = 0; index < 32; index++) {
        const byte = digest[index]!;
        hex += hexDigits[byte >>> 4]! + hexDigits[byte & 15]!;
      }
      return hex;
    })(),
  );
}

function validateModuleMap(modules: unknown): readonly (readonly [name: string, source: string])[] {
  if (typeof modules !== "object" || modules === null || Array.isArray(modules)) {
    throw new NodeGeneratedCodeInputError(
      "Generated-code modules must be a record of source strings",
    );
  }
  const prototype = Object.getPrototypeOf(modules);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NodeGeneratedCodeInputError("Generated-code modules must be a plain record");
  }
  if (Object.getOwnPropertySymbols(modules).length > 0) {
    throw new NodeGeneratedCodeInputError("Generated-code modules cannot have symbol keys");
  }

  const seen = new Set<string>();
  const entries: (readonly [string, string])[] = [];
  const moduleRecord = modules as Record<string, unknown>;
  for (const name of Object.keys(moduleRecord)) {
    validateModuleName(name);
    const canonical = new URL(name, moduleBase).pathname.slice(1);
    if (seen.has(canonical)) {
      throw new NodeGeneratedCodeInputError(`Generated-code module name collision: ${name}`);
    }
    seen.add(canonical);
    const descriptor = Object.getOwnPropertyDescriptor(moduleRecord, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new NodeGeneratedCodeInputError(
        `Generated-code module ${name} must contain source text`,
      );
    }
    entries.push([name, descriptor.value]);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries;
}

function validateModuleName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0 || name.startsWith("/")) {
    throw new NodeGeneratedCodeInputError(
      "Generated-code module names must be non-empty relative paths",
    );
  }
  const segments = name.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || !moduleSegment.test(segment),
    )
  ) {
    throw new NodeGeneratedCodeInputError(`Invalid generated-code module name: ${name}`);
  }
}

function serializeJson(value: unknown): string {
  const ancestors = new Set<object>();
  return serializeJsonValue(value, ancestors);
}

function serializeJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new NodeGeneratedCodeInputError("Generated-code input must be valid JSON");
    return String(value);
  }
  if (typeof value !== "object") {
    throw new NodeGeneratedCodeInputError("Generated-code input must be valid JSON");
  }
  if (ancestors.has(value))
    throw new NodeGeneratedCodeInputError("Generated-code input cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new NodeGeneratedCodeInputError(
          "Generated-code input arrays cannot have symbol keys",
        );
      }
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key !== "length" && !isArrayIndex(key, value.length)) {
          throw new NodeGeneratedCodeInputError(
            "Generated-code input arrays cannot have extra properties",
          );
        }
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new NodeGeneratedCodeInputError(
            "Generated-code input arrays cannot contain holes or accessors",
          );
        }
        items.push(serializeJsonValue(descriptor.value, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NodeGeneratedCodeInputError(
        "Generated-code input must contain only plain JSON objects",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new NodeGeneratedCodeInputError("Generated-code input objects cannot have symbol keys");
    }
    const fields: string[] = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new NodeGeneratedCodeInputError("Generated-code input cannot contain accessors");
      }
      fields.push(`${quote(key)}:${serializeJsonValue(descriptor.value, ancestors)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function readRequestFields(input: NodeGeneratedCodeInvokeInput): {
  readonly id: unknown;
  readonly mainModule: unknown;
  readonly modules: unknown;
  readonly input: unknown;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new NodeGeneratedCodeInputError("Generated-code request must be a plain record");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NodeGeneratedCodeInputError("Generated-code request must be a plain record");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new NodeGeneratedCodeInputError("Generated-code request cannot have symbol keys");
  }
  return {
    id: ownDataValue(input, "id"),
    mainModule: ownDataValue(input, "mainModule"),
    modules: ownDataValue(input, "modules"),
    input: ownDataValue(input, "input"),
  };
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new NodeGeneratedCodeInputError(
      `Generated-code request field ${key} must be a data property`,
    );
  }
  return descriptor.value;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function quote(value: string): string {
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new NodeGeneratedCodeInputError("Generated-code request is invalid");
  return result;
}
