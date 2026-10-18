export const MODULE_TRANSPORT_CONTENT_TYPE = "application/vnd.signalbox.module-transport.v1";

export type ModuleType = "js" | "cjs" | "text" | "wasm";

export interface ModuleDescriptor {
  name: string;
  type: ModuleType;
  bytes: Uint8Array;
}

export interface ModuleTransportLimits {
  maxMetadataBytes: number;
  maxBodyBytes: number;
}

// Transport budgets, not measurements of native WorkerLoader limits.
export const DEFAULT_MODULE_TRANSPORT_LIMITS: Readonly<ModuleTransportLimits> = {
  maxMetadataBytes: 1024 * 1024,
  maxBodyBytes: 128 * 1024 * 1024,
};

interface ModuleMetadata {
  name: string;
  type: ModuleType;
  byteLength: number;
}

function resolveLimits(options: Partial<ModuleTransportLimits>) {
  const limits = { ...DEFAULT_MODULE_TRANSPORT_LIMITS, ...options };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid transport budget");
  }
  if (limits.maxMetadataBytes > 0xffffffff) throw new Error("Invalid metadata budget");
  return limits;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMetadata(value: unknown, limits: ModuleTransportLimits) {
  if (
    !isObject(value) ||
    !Object.hasOwn(value, "input") ||
    !Array.isArray(value.modules) ||
    Object.keys(value).length !== 2
  ) {
    throw new Error("Invalid module metadata");
  }
  const names = new Set<string>();
  const modules: ModuleMetadata[] = [];
  let total = 0;
  for (const module of value.modules) {
    if (
      !isObject(module) ||
      Object.keys(module).length !== 3 ||
      typeof module.name !== "string" ||
      module.name.length === 0 ||
      (module.type !== "js" &&
        module.type !== "cjs" &&
        module.type !== "text" &&
        module.type !== "wasm") ||
      typeof module.byteLength !== "number" ||
      !Number.isSafeInteger(module.byteLength) ||
      module.byteLength < 0
    ) {
      throw new Error("Invalid module descriptor");
    }
    if (names.has(module.name)) throw new Error("Duplicate module name");
    names.add(module.name);
    if (module.byteLength > limits.maxBodyBytes - total)
      throw new Error("Module body budget exceeded");
    total += module.byteLength;
    modules.push({ name: module.name, type: module.type, byteLength: module.byteLength });
  }
  return { input: value.input, modules };
}

/** Input must be JSON-serializable; callers keep module bytes unchanged until consumed. */
export function encodeModuleTransport(
  input: unknown,
  modules: readonly ModuleDescriptor[],
  options: Partial<ModuleTransportLimits> = {},
): ReadableStream<Uint8Array> {
  const limits = resolveLimits(options);
  const bodies = modules.map((module) => {
    if (!(module.bytes instanceof Uint8Array)) throw new Error("Invalid module bytes");
    return module.bytes;
  });
  const metadata = validateMetadata(
    {
      input,
      modules: modules.map(({ name, type }, index) => ({
        name,
        type,
        byteLength: bodies[index]!.byteLength,
      })),
    },
    limits,
  );
  const json = JSON.stringify(metadata);
  // UTF-8 cannot be shorter than the UTF-16 code-unit count.
  if (json.length > limits.maxMetadataBytes) throw new Error("Metadata budget exceeded");
  validateMetadata(JSON.parse(json), limits);
  const encoded = new TextEncoder().encode(json);
  if (encoded.byteLength > limits.maxMetadataBytes) throw new Error("Metadata budget exceeded");
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, encoded.byteLength, false);
  let stage = 0;
  let index = -1;
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stage === 0) {
          controller.enqueue(prefix);
          stage = 1;
        } else {
          while (index < bodies.length) {
            const body = index < 0 ? encoded : bodies[index]!;
            if (offset === body.byteLength) {
              if (index >= 0) bodies[index] = new Uint8Array(0);
              index++;
              offset = 0;
              continue;
            }
            const end = Math.min(offset + 64 * 1024, body.byteLength);
            controller.enqueue(body.subarray(offset, end));
            offset = end;
            return;
          }
          controller.close();
        }
      },
      cancel() {
        bodies.length = 0;
      },
    },
    { highWaterMark: 0 },
  );
}

export interface ModuleTransport {
  readonly input: unknown;
  readModules(): Promise<Record<string, WorkerLoaderModule>>;
  discard(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}

export async function openModuleTransport(
  stream: ReadableStream<Uint8Array>,
  options: Partial<ModuleTransportLimits> = {},
): Promise<ModuleTransport> {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0;
  let closed = false;
  async function cancel(reason?: unknown) {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel(reason);
    } catch {
      // A source's cancellation error must not hide the framing or source error.
    } finally {
      reader.releaseLock();
      chunk = new Uint8Array(0);
    }
  }
  async function nextChunk() {
    while (offset === chunk.byteLength) {
      chunk = new Uint8Array(0);
      offset = 0;
      const next = await reader.read();
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array)) throw new Error("Invalid transport chunk");
      chunk = next.value;
    }
    return true;
  }
  async function consume(length: number, label: string, accept: (bytes: Uint8Array) => void) {
    let remaining = length;
    while (remaining > 0) {
      if (!(await nextChunk())) throw new Error(`Truncated ${label}`);
      const count = Math.min(remaining, chunk.byteLength - offset, 64 * 1024);
      accept(chunk.subarray(offset, offset + count));
      offset += count;
      remaining -= count;
    }
  }
  async function readBytes(length: number, label: string) {
    const bytes = new Uint8Array(length);
    let written = 0;
    await consume(length, label, (part) => {
      bytes.set(part, written);
      written += part.byteLength;
    });
    return bytes;
  }
  try {
    const limits = resolveLimits(options);
    const prefix = await readBytes(4, "metadata length");
    const length = new DataView(prefix.buffer).getUint32(0, false);
    if (length > limits.maxMetadataBytes) throw new Error("Metadata budget exceeded");
    const metadataBytes = await readBytes(length, "metadata");
    const utf8 = { fatal: true, ignoreBOM: true };
    const metadata = validateMetadata(
      JSON.parse(new TextDecoder("utf-8", utf8).decode(metadataBytes)),
      limits,
    );
    async function consumeModules(retain: boolean) {
      try {
        const modules: Record<string, WorkerLoaderModule> = {};
        for (const module of metadata.modules) {
          let value: WorkerLoaderModule;
          if (module.type === "wasm") {
            if (retain) {
              const bytes = await readBytes(module.byteLength, `module ${module.name}`);
              value = { wasm: bytes.buffer };
            } else {
              await consume(module.byteLength, `module ${module.name}`, () => {});
              continue;
            }
          } else {
            const decoder = new TextDecoder("utf-8", utf8);
            let text = "";
            await consume(module.byteLength, `module ${module.name}`, (part) => {
              const decoded = decoder.decode(part, { stream: true });
              if (retain) text += decoded;
            });
            const tail = decoder.decode();
            if (!retain) continue;
            text += tail;
            value =
              module.type === "js"
                ? { js: text }
                : module.type === "cjs"
                  ? { cjs: text }
                  : { text };
          }
          // Module names are opaque, including ordinary object prototype property names.
          Object.defineProperty(modules, module.name, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        if (await nextChunk()) throw new Error("Trailing module transport bytes");
        return modules;
      } catch (error) {
        await cancel(error);
        throw error;
      } finally {
        await cancel();
      }
    }
    let consumption: Promise<void> | undefined;
    let failure: { error: unknown } | undefined;
    function start(retain: boolean) {
      if (consumption || closed) throw new Error("Module bodies already consumed or cancelled");
      const result = consumeModules(retain);
      // Retain completion and failure, never the materialized map after the loader receives it.
      consumption = result.then(
        () => {},
        (error: unknown) => {
          failure = { error };
        },
      );
      return result;
    }
    return {
      input: metadata.input,
      readModules: async () => start(true),
      async discard() {
        if (!consumption) start(false);
        await consumption;
        if (failure) throw failure.error;
      },
      cancel,
    };
  } catch (error) {
    await cancel(error);
    throw error;
  }
}

export async function decodeModuleTransport(
  stream: ReadableStream<Uint8Array>,
  options: Partial<ModuleTransportLimits> = {},
): Promise<{ input: unknown; modules: Record<string, WorkerLoaderModule> }> {
  const transport = await openModuleTransport(stream, options);
  return { input: transport.input, modules: await transport.readModules() };
}
