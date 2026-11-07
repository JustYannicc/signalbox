import { createNodeFs } from "../../isolate/NodeFs.ts";
import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { runKernelExecution } from "../../kernel/KernelExecution.ts";
import type { ClaudeSdkFsReply } from "../ClaudeSdkHostProtocol.ts";
import { serializeHarnessFailure } from "../Harness.ts";

const metadataMethods = [
  "isFile",
  "isDirectory",
  "isBlockDevice",
  "isCharacterDevice",
  "isSymbolicLink",
  "isFIFO",
  "isSocket",
];
const handleMethods = new Set([
  "read",
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
  "close",
]);
const operations = new Set([
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
]);

/** Async SDK operations use the existing authoritative filesystem, without another cache. */
export function createClaudeCliFiles(files: KernelFileSystem) {
  const promises = createNodeFs(files)["fs/promises"];
  const handles = new Map<number, object>();
  let next = 0;
  function encode(value: unknown): ClaudeSdkFsReply {
    if (Array.isArray(value)) return { kind: "entries", entries: value.map(encode) };
    if (
      typeof value === "object" &&
      value !== null &&
      typeof Reflect.get(value, "isFile") === "function"
    ) {
      return {
        kind: "metadata",
        value: Object.fromEntries(Object.entries(value)),
        types: Object.fromEntries(
          metadataMethods.map((key) => [
            key,
            Reflect.apply(Reflect.get(value, key), value, []) === true,
          ]),
        ),
      };
    }
    return { kind: "value", value };
  }
  return {
    async call(
      operation: string,
      args: ReadonlyArray<unknown>,
      signal?: AbortSignal,
    ): Promise<ClaudeSdkFsReply> {
      try {
        let target: object = promises;
        let method = operation;
        const match = /^handle\/(\d+)\/([a-zA-Z]+)$/u.exec(operation);
        if (match) {
          const id = Number(match[1]);
          method = match[2]!;
          if (!handleMethods.has(method)) throw new Error("Unsupported SDK file handle operation");
          const handle = handles.get(id);
          if (handle === undefined)
            throw Object.assign(new Error("SDK file handle is closed"), { code: "EBADF" });
          target = handle;
          if (method === "close") handles.delete(id);
        } else if (!operations.has(operation))
          throw new Error("Unsupported SDK filesystem operation");
        const invoke: unknown = Reflect.get(target, method);
        if (typeof invoke !== "function")
          throw new Error(`SDK filesystem has no ${method} operation`);
        let supplied = [...args];
        if (["readFile", "writeFile", "appendFile"].includes(method) && signal !== undefined) {
          const index = method === "readFile" ? (match ? 0 : 1) : match ? 1 : 2;
          const options = supplied[index];
          supplied[index] =
            typeof options === "string"
              ? { encoding: options, signal }
              : { ...(typeof options === "object" && options !== null ? options : {}), signal };
        }
        signal?.throwIfAborted();
        // FileHandle methods without a signal parameter inherit this call's kernel cancellation.
        const call = () => Reflect.apply(invoke, target, supplied);
        const value: unknown = await (signal === undefined
          ? call()
          : runKernelExecution(signal, call));
        if (!match && (operation === "open" || operation === "opendir")) {
          if (typeof value !== "object" || value === null)
            throw new Error("SDK open returned no handle");
          const id = ++next;
          handles.set(id, value);
          const fd: unknown = Reflect.get(value, "fd");
          return {
            kind: "handle",
            id,
            fd: typeof fd === "number" ? fd : -1,
            directory: operation === "opendir",
          };
        }
        return encode(value);
      } catch (cause) {
        const fields: Record<string, unknown> = {
          message: cause instanceof Error ? cause.message : "SDK filesystem operation failed",
          cause: serializeHarnessFailure(cause),
        };
        if (typeof cause === "object" && cause !== null)
          for (const key of ["name", "code", "errno", "syscall", "path", "dest"])
            if (Reflect.has(cause, key)) fields[key] = Reflect.get(cause, key);
        return { kind: "error", fields };
      }
    },
    async close() {
      const remaining = [...handles.values()];
      handles.clear();
      const results = await Promise.allSettled(
        remaining.map((handle) => {
          const close: unknown = Reflect.get(handle, "close");
          return typeof close === "function" ? Reflect.apply(close, handle, []) : undefined;
        }),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0)
        throw new AggregateError(failures, "SDK file handles could not close");
    },
  };
}
