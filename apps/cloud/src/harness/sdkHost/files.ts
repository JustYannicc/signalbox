import { claudeSdkIo } from "../ClaudeSdkIo.ts";
// @effect-diagnostics nodeBuiltinImport:off - SDK file APIs use native Buffer and streams over the async Computer capability.
import * as NodeBuffer from "node:buffer";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import type { ClaudeCliProcessPort, ClaudeSdkFsReply } from "../ClaudeSdkHostProtocol.ts";

const methods = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "link",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
];
const handleMethods = [
  "write",
  "readFile",
  "writeFile",
  "appendFile",
  "stat",
  "truncate",
  "sync",
  "datasync",
  "chmod",
  "chown",
  "utimes",
];

/** The SDK has async file APIs; synchronous workspace access remains inside the CLI. */
export function createClaudeSdkFiles(port: Pick<ClaudeCliProcessPort, "fs" | "cancelIo">) {
  const call = async (operation: string, ...args: unknown[]) => {
    let signal: AbortSignal | undefined;
    const serializable = args.map((arg) => {
      if (
        typeof arg !== "object" ||
        arg === null ||
        !(Reflect.get(arg, "signal") instanceof AbortSignal)
      )
        return arg;
      signal = Reflect.get(arg, "signal");
      const { signal: _signal, ...rest } = arg as Record<string, unknown>;
      return rest;
    });
    return decode(await claudeSdkIo(port, signal, (id) => port.fs(id, operation, serializable)));
  };
  function decode(reply: ClaudeSdkFsReply): unknown {
    switch (reply.kind) {
      case "error":
        throw Object.assign(new Error(String(reply.fields.message)), reply.fields);
      case "value":
        return reply.value instanceof Uint8Array
          ? NodeBuffer.Buffer.from(reply.value)
          : reply.value;
      case "entries":
        return reply.entries.map(decode);
      case "metadata":
        return Object.assign(
          {},
          reply.value,
          Object.fromEntries(
            Object.entries(reply.types).map(([name, value]) => [name, () => value]),
          ),
        );
      case "handle":
        return handle(reply);
    }
  }
  function handle(descriptor: Extract<ClaudeSdkFsReply, { readonly kind: "handle" }>) {
    const operation = (method: string, ...args: unknown[]) =>
      call(`handle/${descriptor.id}/${method}`, ...args);
    let closed: Promise<unknown> | undefined;
    const close = () => (closed ??= operation("close"));
    const read = async (...args: unknown[]) => {
      const result = await operation("read", ...args);
      if (typeof result !== "object" || result === null) return result;
      const returned: unknown = Reflect.get(result, "buffer");
      const supplied =
        args[0] instanceof Uint8Array
          ? args[0]
          : typeof args[0] === "object" && args[0] !== null
            ? Reflect.get(args[0], "buffer")
            : undefined;
      if (supplied instanceof Uint8Array && returned instanceof Uint8Array) {
        supplied.set(returned);
        return { ...result, buffer: supplied };
      }
      if (returned instanceof Uint8Array)
        return { ...result, buffer: NodeBuffer.Buffer.from(returned) };
      return result;
    };
    const file = {
      fd: descriptor.fd,
      read,
      close,
      ...Object.fromEntries(
        handleMethods.map((method) => [method, (...args: unknown[]) => operation(method, ...args)]),
      ),
      async [Symbol.asyncDispose]() {
        await close();
      },
    };
    if (descriptor.directory)
      return Object.assign(file, {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const entry = await read();
              if (entry === null) return;
              yield entry;
            }
          } finally {
            await close();
          }
        },
      });
    return file;
  }
  const promises = Object.assign(
    Object.fromEntries(
      methods.map((method) => [method, (...args: unknown[]) => call(method, ...args)]),
    ),
    { constants: NodeFS.constants },
  );
  const unsupported = (name: string): never => {
    throw Object.assign(
      new Error(`The SDK host cannot use synchronous Computer operation fs.${name}`),
      { code: "ENOTSUP" },
    );
  };
  const fs = new Proxy<Record<string, unknown>>(
    {
      promises,
      constants: NodeFS.constants,
      createReadStream(
        path: unknown,
        options?: {
          readonly start?: number;
          readonly end?: number;
          readonly highWaterMark?: number;
        },
      ) {
        return NodeStream.Readable.from(
          (async function* () {
            const descriptor = await call("open", path, "r");
            if (typeof descriptor !== "object" || descriptor === null)
              throw new Error("SDK read stream has no file handle");
            const read = Reflect.get(descriptor, "read") as (
              ...args: unknown[]
            ) => Promise<unknown>;
            const close = Reflect.get(descriptor, "close") as () => Promise<unknown>;
            let position = options?.start ?? 0;
            try {
              for (;;) {
                const length = Math.min(
                  options?.highWaterMark ?? 65_536,
                  (options?.end ?? Infinity) - position + 1,
                );
                if (length <= 0) return;
                const buffer = NodeBuffer.Buffer.alloc(length);
                const result = await read(buffer, 0, length, position);
                const bytesRead: unknown =
                  typeof result === "object" && result !== null
                    ? Reflect.get(result, "bytesRead")
                    : undefined;
                if (typeof bytesRead !== "number")
                  throw new Error("SDK read stream returned no byte count");
                if (bytesRead === 0) return;
                position += bytesRead;
                yield buffer.subarray(0, bytesRead);
              }
            } finally {
              await close();
            }
          })(),
        );
      },
      createWriteStream(
        path: unknown,
        options?: { readonly flags?: string; readonly mode?: number },
      ) {
        const opened = call("open", path, options?.flags ?? "w", options?.mode);
        const invoke = async (method: string, args: unknown[]) => {
          const file = await opened;
          if (typeof file !== "object" || file === null)
            throw new Error("SDK write stream has no file handle");
          const operation: unknown = Reflect.get(file, method);
          if (typeof operation !== "function") throw new Error(`SDK file handle has no ${method}`);
          return await Reflect.apply(operation, file, args);
        };
        return new NodeStream.Writable({
          write(chunk: NodeBuffer.Buffer, _encoding, callback) {
            void invoke("write", [chunk]).then(() => callback(), callback);
          },
          final(callback) {
            void invoke("close", []).then(() => callback(), callback);
          },
          destroy(error, callback) {
            void invoke("close", []).then(() => callback(error), callback);
          },
        });
      },
    },
    {
      get(target, name) {
        if (name === "default") return fs;
        if (typeof name !== "string" || Object.hasOwn(target, name))
          return Reflect.get(target, name);
        if (name.endsWith("Sync")) {
          const operation = () => unsupported(name);
          return Object.assign(operation, { native: operation });
        }
        if (methods.includes(name))
          return (...args: unknown[]) => {
            const callback: unknown = args.pop();
            if (typeof callback !== "function")
              throw new TypeError(`fs.${name} requires a callback`);
            void call(name, ...args).then(
              (value) => callback(null, value),
              (cause: unknown) => callback(cause),
            );
          };
        return undefined;
      },
    },
  );
  return { fs, promises, call };
}
