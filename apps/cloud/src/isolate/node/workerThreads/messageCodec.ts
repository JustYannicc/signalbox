import * as NodeUtil from "node:util";
import { dataCloneError } from "./portState.ts";

export type WorkerMessagePortHandle = Readonly<{
  id: string;
  lease: string;
  previousLease: string;
}>;

export type PreparedWorkerMessagePortTransfer = Readonly<{
  handle: WorkerMessagePortHandle;
  commit: () => void;
}>;

export interface WorkerMessagePortHooks<Port extends object> {
  /** Keep recognizing every issued facade, including one whose transfer already committed. */
  isPort(value: unknown): value is Port;
  /** Stage a fresh lease without changing ownership; invalid ports throw DataCloneError and commit must not throw. */
  prepareTransfer(port: Port): PreparedWorkerMessagePortTransfer;
  /** Adopt every handle as one transaction and return one port per handle in the same order. */
  adoptTransfers(handles: readonly WorkerMessagePortHandle[]): readonly Port[];
}

export type EncodedWorkerMessage = Readonly<{
  value: unknown;
  ports: readonly Readonly<{
    marker: object;
    handle: WorkerMessagePortHandle;
  }>[];
}>;

type TransferHooks<Port extends object> = Pick<
  WorkerMessagePortHooks<Port>,
  "isPort" | "prepareTransfer"
>;

type AdoptionHooks<Port extends object> = Pick<WorkerMessagePortHooks<Port>, "adoptTransfers">;

const mapProbe = {};
const setProbe = {};
const weakCollectionProbe = {};

const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)?.get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get;
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const isProxy = typeof NodeUtil.types?.isProxy === "function" ? NodeUtil.types.isProxy : undefined;

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  if (sharedArrayBufferByteLength === undefined || value === null || typeof value !== "object") {
    return false;
  }
  try {
    sharedArrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

function viewBuffer(value: ArrayBufferView): ArrayBufferLike {
  if (dataViewBuffer !== undefined) {
    try {
      return dataViewBuffer.call(value) as ArrayBufferLike;
    } catch {
      // Try the typed-array brand.
    }
  }
  if (typedArrayBuffer !== undefined) {
    try {
      return typedArrayBuffer.call(value) as ArrayBufferLike;
    } catch {
      // The view has no supported backing buffer.
    }
  }
  throw dataCloneError("Unsupported ArrayBuffer view");
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (arrayBufferByteLength === undefined || value === null || typeof value !== "object") {
    return false;
  }
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

function hasMapBrand(value: object): value is Map<unknown, unknown> {
  try {
    Map.prototype.has.call(value, mapProbe);
    return true;
  } catch {
    return false;
  }
}

function hasSetBrand(value: object): value is Set<unknown> {
  try {
    Set.prototype.has.call(value, setProbe);
    return true;
  } catch {
    return false;
  }
}

function hasWeakMapBrand(value: object): boolean {
  try {
    WeakMap.prototype.has.call(value, weakCollectionProbe);
    return true;
  } catch {
    return false;
  }
}

function hasWeakSetBrand(value: object): boolean {
  try {
    WeakSet.prototype.has.call(value, weakCollectionProbe);
    return true;
  } catch {
    return false;
  }
}

function hasPrototype(value: object, prototype: object | null): boolean {
  let current = Object.getPrototypeOf(value) as object | null;
  while (current !== null) {
    if (current === prototype) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function isUnsupportedWeakValue(value: object): boolean {
  if (hasWeakMapBrand(value) || hasWeakSetBrand(value)) return true;
  if (typeof Promise !== "undefined" && hasPrototype(value, Promise.prototype)) return true;
  if (typeof WeakRef !== "undefined" && hasPrototype(value, WeakRef.prototype)) return true;
  if (
    typeof FinalizationRegistry !== "undefined" &&
    hasPrototype(value, FinalizationRegistry.prototype)
  ) {
    return true;
  }
  try {
    Symbol.prototype.valueOf.call(value);
    return true;
  } catch {
    return false;
  }
}

function makeErrorShell(source: Error): Error {
  if (typeof AggregateError !== "undefined" && source instanceof AggregateError) return new Error();
  if (source instanceof EvalError) return new EvalError();
  if (source instanceof RangeError) return new RangeError();
  if (source instanceof ReferenceError) return new ReferenceError();
  if (source instanceof SyntaxError) return new SyntaxError();
  if (source instanceof TypeError) return new TypeError();
  if (source instanceof URIError) return new URIError();
  return new Error();
}

function copyErrorField(
  source: Error,
  target: Error,
  key: "message" | "stack",
  cloneValue: (value: unknown) => unknown,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return;
  const value = "value" in descriptor ? descriptor.value : Reflect.get(source, key, source);
  Object.defineProperty(target, key, {
    value: cloneValue(value),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function hasNativeCloneBrand(value: object): boolean {
  if (ArrayBuffer.isView(value)) return true;
  if (isSharedArrayBuffer(value) || isArrayBuffer(value)) return true;
  try {
    Date.prototype.getTime.call(value);
    return true;
  } catch {
    // Not a Date.
  }
  try {
    regexpSource?.call(value);
    if (regexpSource !== undefined) return true;
  } catch {
    // Not a RegExp.
  }
  if (typeof Number !== "undefined") {
    try {
      Number.prototype.valueOf.call(value);
      return true;
    } catch {
      // Not a boxed number.
    }
  }
  try {
    Boolean.prototype.valueOf.call(value);
    return true;
  } catch {
    // Not a boxed boolean.
  }
  try {
    String.prototype.valueOf.call(value);
    return true;
  } catch {
    // Not a boxed string.
  }
  try {
    BigInt.prototype.valueOf.call(value);
    return true;
  } catch {
    // Not a boxed bigint.
  }
  for (const name of ["Blob", "File", "CryptoKey", "ImageData", "DOMException"]) {
    const constructor = Reflect.get(globalThis, name) as Function | undefined;
    if (typeof constructor === "function" && value instanceof constructor) return true;
  }
  return false;
}

export function encodeWorkerMessage<Port extends object>(
  value: unknown,
  options: Readonly<{
    transfer?: readonly unknown[];
    ports: TransferHooks<Port>;
    sharedMemory?: "same-isolate";
  }>,
): EncodedWorkerMessage {
  const transferList = options.transfer;
  const allowSharedMemory = options.sharedMemory === "same-isolate";
  const portMarkers = new WeakMap<object, object>();
  const portTransfers: Array<{
    port: Port;
    marker: object;
    prepared: PreparedWorkerMessagePortTransfer;
  }> = [];
  const nativeTransfers: unknown[] | undefined = transferList === undefined ? undefined : [];

  if (transferList !== undefined) {
    const seenPorts = new Set<object>();
    const pendingPorts: Array<{ port: Port; marker: object }> = [];

    for (const item of transferList) {
      if (isSharedArrayBuffer(item)) {
        throw dataCloneError("SharedArrayBuffer cannot be transferred");
      }
      if (options.ports.isPort(item)) {
        if (seenPorts.has(item))
          throw dataCloneError("A MessagePort cannot appear twice in transfer");
        seenPorts.add(item);
        pendingPorts.push({ port: item, marker: {} });
      } else {
        nativeTransfers?.push(item);
      }
    }

    for (const pending of pendingPorts) {
      const prepared = options.ports.prepareTransfer(pending.port);
      portMarkers.set(pending.port, pending.marker);
      portTransfers.push({ ...pending, prepared });
    }
  }

  const seen = new WeakMap<object, object>();
  const cloneForNative = (source: unknown): unknown => {
    if (source === null || (typeof source !== "object" && typeof source !== "function")) {
      if (typeof source === "symbol") throw dataCloneError("Symbols cannot be cloned");
      return source;
    }
    if (typeof source === "function") throw dataCloneError("Functions cannot be cloned");

    if (options.ports.isPort(source)) {
      const marker = portMarkers.get(source);
      if (marker === undefined) {
        throw dataCloneError("A MessagePort in the message must also appear in transfer");
      }
      return marker;
    }
    if (isProxy?.(source)) throw dataCloneError("Proxy objects cannot be cloned");

    const previous = seen.get(source);
    if (previous !== undefined) return previous;

    if (isSharedArrayBuffer(source)) {
      if (!allowSharedMemory)
        throw dataCloneError("SharedArrayBuffer is not supported by worker messages");
      seen.set(source, source);
      return source;
    }
    if (ArrayBuffer.isView(source)) {
      if (isSharedArrayBuffer(viewBuffer(source))) {
        if (!allowSharedMemory) {
          throw dataCloneError(
            "Views backed by SharedArrayBuffer are not supported by worker messages",
          );
        }
      }
      seen.set(source, source);
      return source;
    }

    if (isUnsupportedWeakValue(source)) {
      throw dataCloneError("This value cannot be cloned");
    }

    if (hasMapBrand(source)) {
      const target = new Map<unknown, unknown>();
      seen.set(source, target);
      for (const [key, entry] of Map.prototype.entries.call(source)) {
        target.set(cloneForNative(key), cloneForNative(entry));
      }
      return target;
    }

    if (hasSetBrand(source)) {
      const target = new Set<unknown>();
      seen.set(source, target);
      for (const entry of Set.prototype.values.call(source)) target.add(cloneForNative(entry));
      return target;
    }

    if (source instanceof Error) {
      const target = makeErrorShell(source);
      seen.set(source, target);
      copyErrorField(source, target, "message", cloneForNative);
      copyErrorField(source, target, "stack", cloneForNative);
      const cause = Object.getOwnPropertyDescriptor(source, "cause");
      if (cause !== undefined && "value" in cause) {
        Object.defineProperty(target, "cause", {
          value: cloneForNative(cause.value),
          configurable: true,
          enumerable: false,
          writable: true,
        });
      }
      return target;
    }

    if (hasNativeCloneBrand(source)) {
      if (isSharedArrayBuffer(source)) {
        throw dataCloneError("SharedArrayBuffer is not supported by worker messages");
      }
      seen.set(source, source);
      return source;
    }

    const target: object = Array.isArray(source) ? [] : {};
    seen.set(source, target);
    if (Array.isArray(source)) (target as unknown[]).length = source.length;
    // Native traversal must snapshot earlier values before a later getter mutates them.
    for (const key of Object.keys(source)) {
      Object.defineProperty(target, key, {
        get() {
          return cloneForNative(Reflect.get(source, key, source));
        },
        configurable: true,
        enumerable: true,
      });
    }
    return target;
  };

  const envelope = {
    value: cloneForNative(value),
    ports: portTransfers.map(({ marker, prepared }) => ({ marker, handle: prepared.handle })),
  };
  const cloneOptions =
    nativeTransfers === undefined ? undefined : { transfer: nativeTransfers as Transferable[] };
  const packet = structuredClone(envelope, cloneOptions) as EncodedWorkerMessage;

  for (const { prepared } of portTransfers) prepared.commit();
  return packet;
}

export function decodeWorkerMessage<Port extends object, Value = unknown>(
  packet: EncodedWorkerMessage,
  ports: AdoptionHooks<Port>,
): Value {
  if (packet === null || typeof packet !== "object" || !Array.isArray(packet.ports)) {
    throw dataCloneError("Invalid worker message packet");
  }

  const markers = new Map<object, WorkerMessagePortHandle>();
  const handles: WorkerMessagePortHandle[] = [];
  for (const entry of packet.ports) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.marker === null ||
      typeof entry.marker !== "object" ||
      entry.handle === null ||
      typeof entry.handle !== "object" ||
      typeof entry.handle.id !== "string" ||
      typeof entry.handle.lease !== "string" ||
      typeof entry.handle.previousLease !== "string" ||
      markers.has(entry.marker)
    ) {
      throw dataCloneError("Invalid worker message port entry");
    }
    markers.set(entry.marker, entry.handle);
    handles.push(entry.handle);
  }

  const adopted = handles.length === 0 ? [] : ports.adoptTransfers(handles);
  if (adopted.length !== handles.length) {
    throw new TypeError("Port adoption must return one port per transferred handle");
  }
  const replacements = new Map<object, Port>();
  let adoptedIndex = 0;
  for (const marker of markers.keys()) replacements.set(marker, adopted[adoptedIndex++]!);

  const visited = new WeakSet<object>();
  const replace = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const port = replacements.get(value);
    if (port !== undefined) return port;
    if (visited.has(value)) return value;
    visited.add(value);

    if (hasMapBrand(value)) {
      const entries: Array<[unknown, unknown]> = [];
      for (const [key, entry] of Map.prototype.entries.call(value)) {
        entries.push([replace(key), replace(entry)]);
      }
      Map.prototype.clear.call(value);
      for (const [key, entry] of entries) Map.prototype.set.call(value, key, entry);
      return value;
    }
    if (hasSetBrand(value)) {
      const entries = Array.from(Set.prototype.values.call(value), replace);
      Set.prototype.clear.call(value);
      for (const entry of entries) Set.prototype.add.call(value, entry);
      return value;
    }
    if (ArrayBuffer.isView(value) || isSharedArrayBuffer(value)) return value;

    if (value instanceof Error) {
      for (const key of ["cause", "message", "stack"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && "value" in descriptor) {
          Object.defineProperty(value, key, { ...descriptor, value: replace(descriptor.value) });
        }
      }
      return value;
    }

    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        Object.defineProperty(value, key, { ...descriptor, value: replace(descriptor.value) });
      }
    }
    return value;
  };

  return replace(packet.value) as Value;
}
