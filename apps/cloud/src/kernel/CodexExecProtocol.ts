// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the portable wire boundary uses workerd's byte codecs without an Effect runtime.
import * as NodeBuffer from "node:buffer";

// Codex 0.162.1 exec-server-protocol uses camelCase JSON-RPC without a jsonrpc field.
export type RequestId = string | number | bigint;
export type Message = { id?: RequestId; method: string; params?: unknown };
export type Reply =
  | { id: RequestId; result: unknown }
  | { id: RequestId; error: { code: number; message: string } };
export type Notification = { method: string; params: unknown };

export interface EnvironmentInfo {
  readonly shell: { readonly name: string; readonly path: string };
  readonly executorVersion: string;
  readonly providerId?: string;
  readonly cwd?: string | null;
  readonly userHomeDir?: string;
  readonly platformOs?: string;
  readonly prependPathDirs?: readonly string[];
  readonly temporaryDirectories?: readonly string[];
  readonly tempDir?: string;
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "CodexExecRpcError";
  }
}

export const invalidParams = (message: string): never => {
  throw new RpcError(-32602, message);
};
export const invalidRequest = (message: string): never => {
  throw new RpcError(-32600, message);
};

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidParams("Expected an object");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, field: string): string {
  if (typeof value !== "string") return invalidParams(`${field} must be a string`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") return invalidParams(`${field} must be a boolean`);
  return value;
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : parse(value);
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return invalidParams(`${field} must be an array`);
  return value.map((entry) => string(entry, field));
}

function environment(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, entry]) => [key, string(entry, "env value")]),
  );
}

function unsigned(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidParams(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

export function decodeMessage(text: string, maxBytes = 16 * 1024 * 1024): Message {
  if (NodeBuffer.Buffer.byteLength(text) > maxBytes)
    return invalidRequest("Message exceeds byte limit");
  let value: unknown;
  const numericIds = new WeakMap<object, string>();
  try {
    const parse: (
      source: string,
      reviver: (
        this: object,
        key: string,
        value: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown = JSON.parse;
    value = parse(text, function (key, entry, context) {
      if (key === "id" && typeof entry === "number" && context?.source !== undefined) {
        numericIds.set(this, context.source);
      }
      return entry;
    });
  } catch {
    return invalidRequest("Invalid JSON");
  }
  const pending = [value];
  let remaining = 256 * 1024;
  while (pending.length > 0) {
    if (--remaining < 0) return invalidRequest("Message exceeds value limit");
    const current = pending.pop();
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRequest("Expected a JSON-RPC object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.method !== "string") return invalidRequest("Expected a method");
  let id: RequestId | undefined;
  if (
    Object.hasOwn(record, "id") &&
    typeof record.id !== "string" &&
    typeof record.id !== "number"
  ) {
    return invalidRequest("Request id must be a string or signed 64-bit integer");
  }
  if (typeof record.id === "string") id = record.id;
  if (typeof record.id === "number") {
    const source = numericIds.get(record);
    if (source === undefined) {
      if (!Number.isSafeInteger(record.id))
        return invalidRequest("Cannot decode an exact numeric request id");
      id = record.id;
    } else {
      if (!/^-?(0|[1-9][0-9]*)$/.test(source))
        return invalidRequest("Request id must be an integer");
      const integer = BigInt(source);
      if (integer < -9223372036854775808n || integer > 9223372036854775807n) {
        return invalidRequest("Request id is outside signed 64-bit range");
      }
      id = Number.isSafeInteger(record.id) ? record.id : integer;
    }
  }
  return {
    ...(id === undefined ? {} : { id }),
    method: record.method,
    params: record.params,
  };
}

export function encodeMessage(message: Reply | Notification): string {
  if (!("id" in message) || typeof message.id !== "bigint") return JSON.stringify(message);
  const body = "result" in message ? { result: message.result } : { error: message.error };
  return `{"id":${message.id},${JSON.stringify(body).slice(1)}`;
}

export function initializeParams(value: unknown) {
  const params = object(value);
  return {
    clientName: string(params.clientName, "clientName"),
    resumeSessionId: optional(params.resumeSessionId, (entry) => string(entry, "resumeSessionId")),
  };
}

export function startParams(value: unknown) {
  const params = object(value);
  const argv = strings(params.argv, "argv");
  if (argv.length === 0 || argv[0] === "") return invalidParams("argv must contain an executable");
  const cwd = string(params.cwd, "cwd");
  try {
    if (new URL(cwd).protocol !== "file:") return invalidParams("cwd must be a file URI");
  } catch {
    return invalidParams("cwd must be a file URI");
  }
  return {
    processId: string(params.processId, "processId"),
    argv,
    cwd,
    env: environment(params.env),
    tty: boolean(params.tty, "tty"),
    pipeStdin: params.pipeStdin === undefined ? false : boolean(params.pipeStdin, "pipeStdin"),
    arg0: optional(params.arg0, (entry) => string(entry, "arg0")),
    envPolicy: optional(params.envPolicy, object),
    shellSnapshot: optional(params.shellSnapshot, object),
    sandbox: optional(params.sandbox, object),
    enforceManagedNetwork:
      params.enforceManagedNetwork === undefined
        ? false
        : boolean(params.enforceManagedNetwork, "enforceManagedNetwork"),
    managedNetwork: optional(params.managedNetwork, object),
    networkProxy: optional(params.networkProxy, object),
    metadata: optional(params.metadata, object),
  };
}

export type StartParams = ReturnType<typeof startParams>;

export function processIdParams(value: unknown) {
  return { processId: string(object(value).processId, "processId") };
}

export function readParams(value: unknown) {
  const params = object(value);
  return {
    ...processIdParams(params),
    afterSeq: optional(params.afterSeq, (entry) => unsigned(entry, "afterSeq")),
    maxBytes: optional(params.maxBytes, (entry) => unsigned(entry, "maxBytes")),
    waitMs: optional(params.waitMs, (entry) => unsigned(entry, "waitMs")),
  };
}

export function writeParams(value: unknown) {
  const params = object(value);
  const encoded = string(params.chunk, "chunk");
  const chunk = NodeBuffer.Buffer.from(encoded, "base64");
  if (chunk.toString("base64") !== encoded)
    return invalidParams("chunk must be standard padded base64");
  const writeId = string(params.writeId, "writeId");
  if (writeId.length === 0) return invalidParams("writeId must not be empty");
  return { ...processIdParams(params), chunk, writeId };
}

export function signalParams(value: unknown) {
  const params = object(value);
  if (params.signal !== "interrupt") return invalidParams("Unknown process signal");
  return processIdParams(params);
}
