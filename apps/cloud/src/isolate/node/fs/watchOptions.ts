// @effect-diagnostics nodeBuiltinImport:off - These types describe the Node filesystem watcher contract.
import * as NodeBuffer from "node:buffer";
import type * as NodeFS from "node:fs";
import type { PathLike } from "./path.ts";

export type WatchEventType = "change" | "rename";
export type WatchFilename = string | NodeBuffer.Buffer | null;

export interface WatchEvent {
  readonly eventType: WatchEventType;
  readonly filename: WatchFilename;
}

export interface WatchIterator extends AsyncIterableIterator<WatchEvent> {
  return(value?: unknown): Promise<IteratorResult<WatchEvent>>;
  throw(error?: unknown): Promise<IteratorResult<WatchEvent>>;
}

export type WatchListener = (eventType: WatchEventType, filename: WatchFilename) => void;

export interface WatchOptions {
  readonly persistent?: boolean;
  readonly recursive?: boolean;
  readonly encoding?: BufferEncoding | "buffer";
  readonly signal?: AbortSignal;
}

export interface WatchIteratorOptions extends WatchOptions {
  readonly maxQueue?: number;
  readonly overflow?: "ignore" | "error" | "throw";
}

export interface WatchFunction {
  (path: PathLike, listener?: WatchListener): NodeFS.FSWatcher;
  (
    path: PathLike,
    options?: WatchOptions | BufferEncoding | "buffer",
    listener?: WatchListener,
  ): NodeFS.FSWatcher;
}

export interface ResolvedWatchOptions {
  readonly persistent: boolean;
  readonly recursive: boolean;
  readonly encoding: BufferEncoding | "buffer";
  readonly signal?: AbortSignal;
}

export interface ResolvedIteratorOptions extends ResolvedWatchOptions {
  readonly maxQueue: number;
  readonly overflow: "ignore" | "error";
}

export type RegisterCleanup = (close: () => void) => () => void;

export function invalidWatchArg(name: string, expected: string, value: unknown): never {
  const received =
    value === null
      ? "Received null"
      : `Received ${Array.isArray(value) ? "an instance of Array" : `type ${typeof value}`}`;
  throw Object.assign(new TypeError(`The "${name}" argument must be ${expected}. ${received}`), {
    code: "ERR_INVALID_ARG_TYPE",
  });
}

export function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

function validateEncoding(value: unknown): BufferEncoding | "buffer" {
  if (value === "buffer" || (typeof value === "string" && NodeBuffer.Buffer.isEncoding(value))) {
    return value as BufferEncoding | "buffer";
  }
  throw Object.assign(new TypeError(`The "encoding" option is invalid: ${String(value)}`), {
    code: "ERR_INVALID_ARG_VALUE",
  });
}

export function parseWatchOptions(
  options: WatchOptions | BufferEncoding | "buffer" | WatchListener | undefined,
  listener: unknown,
): { readonly options: ResolvedWatchOptions; readonly listener?: WatchListener } {
  if (typeof options === "function") {
    listener = options;
    options = undefined;
  }

  let values: WatchOptions;
  if (options === undefined) values = {};
  else if (typeof options === "string") values = { encoding: options as BufferEncoding | "buffer" };
  else if (typeof options === "object" && options !== null && !Array.isArray(options))
    values = options;
  else invalidWatchArg("options", "of type string or an object", options);

  if (listener !== undefined && typeof listener !== "function") {
    invalidWatchArg("listener", "of type function", listener);
  }
  const persistent = values.persistent ?? true;
  const recursive = values.recursive ?? false;
  if (typeof persistent !== "boolean")
    invalidWatchArg("options.persistent", "of type boolean", persistent);
  if (typeof recursive !== "boolean")
    invalidWatchArg("options.recursive", "of type boolean", recursive);
  if (values.signal !== undefined && !isAbortSignal(values.signal)) {
    invalidWatchArg("options.signal", "an AbortSignal", values.signal);
  }

  return {
    options: {
      persistent,
      recursive,
      encoding: validateEncoding(values.encoding ?? "utf8"),
      ...(values.signal === undefined ? {} : { signal: values.signal }),
    },
    ...(listener === undefined ? {} : { listener: listener as WatchListener }),
  };
}

export function parseWatchIteratorOptions(
  options: WatchIteratorOptions | BufferEncoding | "buffer" | undefined,
): ResolvedIteratorOptions {
  let values: WatchIteratorOptions;
  if (options === undefined) values = {};
  else if (typeof options === "string") values = { encoding: options as BufferEncoding | "buffer" };
  else if (typeof options === "object" && options !== null && !Array.isArray(options))
    values = options;
  else invalidWatchArg("options", "of type string or an object", options);

  const base = parseWatchOptions(values, undefined).options;
  const maxQueue = values.maxQueue ?? 2048;
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
    throw Object.assign(
      new RangeError('The "options.maxQueue" argument must be a non-negative safe integer'),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  const overflow = values.overflow ?? "ignore";
  if (overflow !== "ignore" && overflow !== "error" && overflow !== "throw") {
    throw Object.assign(
      new TypeError('The "options.overflow" argument must be "ignore", "error", or "throw"'),
      { code: "ERR_INVALID_ARG_VALUE" },
    );
  }

  return {
    ...base,
    maxQueue,
    overflow: overflow === "ignore" ? "ignore" : "error",
  };
}
