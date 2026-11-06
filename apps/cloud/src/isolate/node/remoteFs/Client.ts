import type { NodeFsOperation, NodeFsArguments, NodeFsResult } from "../../NodeFsBackend.ts";
import { nodeFsError } from "../fs/errors.ts";
import { NodeFsSyscalls, type NodeFsSyscallTransport } from "./Calls.ts";
import { createRemoteFileMetadata } from "./Metadata.ts";
import { createRemoteFileIo } from "./Io.ts";
import { createRemoteDirectories } from "./Directories.ts";

// Optional Node operands precede the cancellation signal, even when the caller omits them.
const operands = {
  access: 3,
  chmod: 3,
  fchmod: 2,
  chown: 4,
  fchown: 3,
  close: 1,
  fstat: 1,
  fsetTimes: 2,
  ftruncate: 2,
  link: 2,
  lstat: 1,
  mkdir: 2,
  open: 3,
  read: 3,
  readdir: 1,
  readlink: 1,
  realpath: 1,
  rename: 2,
  rmdir: 1,
  setTimes: 3,
  stat: 1,
  symlink: 2,
  sync: 2,
  truncate: 2,
  unlink: 1,
  write: 3,
} satisfies Record<NodeFsOperation, number>;

const syscalls = {
  access: "access",
  chmod: "chmod",
  fchmod: "fchmod",
  chown: "chown",
  fchown: "fchown",
  close: "close",
  fstat: "fstat",
  fsetTimes: "futimes",
  ftruncate: "ftruncate",
  link: "link",
  lstat: "lstat",
  mkdir: "mkdir",
  open: "open",
  read: "read",
  readdir: "scandir",
  readlink: "readlink",
  realpath: "realpath",
  rename: "rename",
  rmdir: "rmdir",
  setTimes: "utimes",
  stat: "stat",
  symlink: "symlink",
  sync: "fsync",
  truncate: "truncate",
  unlink: "unlink",
  write: "write",
  move: "dup2",
  seek: "lseek",
  position: "lseek",
} satisfies Record<NodeFsOperation | "move" | "seek" | "position", string>;

function errorContext(name: keyof typeof syscalls, args: readonly unknown[]) {
  const path = typeof args[0] === "string" ? args[0] : undefined;
  const dest =
    name === "link" || name === "rename" || name === "symlink"
      ? typeof args[1] === "string"
        ? args[1]
        : undefined
      : undefined;
  const syscall =
    name === "chown" && typeof args[0] === "number"
      ? "fchown"
      : name === "setTimes" && typeof args[0] === "number"
        ? "futimes"
        : name === "sync" && args[1] === true
          ? "fdatasync"
          : syscalls[name];
  return { syscall, path, dest };
}

/** Node's async file APIs use the existing bounded syscall capability, not a local filesystem. */
export function createNodeFsSyscallClient(options: {
  readonly syscalls: NodeFsSyscallTransport;
  readonly rootDescriptor: number;
  readonly posix: boolean;
  readonly signal?: AbortSignal;
}) {
  const calls = new NodeFsSyscalls(options.syscalls, options.rootDescriptor);
  const metadata = createRemoteFileMetadata(calls, options.posix);
  const withLifetime = (signal?: AbortSignal) =>
    options.signal === undefined
      ? signal
      : signal === undefined
        ? options.signal
        : AbortSignal.any([options.signal, signal]);
  const io = createRemoteFileIo(
    calls,
    async (path, signal) => (await metadata.lstat(path, withLifetime(signal))).type,
  );
  const directories = createRemoteDirectories(calls, io);
  const operations = { ...metadata, ...io, ...directories };
  const contextualOperations = Object.fromEntries(
    (Object.keys(operations) as (keyof typeof operations)[]).map((name) => [
      name,
      async (...args: unknown[]) => {
        try {
          return await Reflect.apply(operations[name], operations, args);
        } catch (cause) {
          const context = errorContext(name, args);
          throw nodeFsError(cause, context.syscall, context.path, context.dest);
        }
      },
    ]),
  ) as typeof operations;
  return {
    ...contextualOperations,
    async call<K extends NodeFsOperation>(
      name: K,
      args: NodeFsArguments<K>,
      signal?: AbortSignal,
    ): Promise<NodeFsResult<K>> {
      const values: unknown[] = [...args];
      while (values.length < operands[name]) values.push(undefined);
      values.push(withLifetime(signal));
      return (await Reflect.apply(
        contextualOperations[name],
        contextualOperations,
        values,
      )) as NodeFsResult<K>;
    },
  };
}

export type NodeFsRemoteOperations = Omit<ReturnType<typeof createNodeFsSyscallClient>, "call">;
