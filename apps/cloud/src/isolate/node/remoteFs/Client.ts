import type {
  NodeFsOperations,
  NodeFsOperation,
  NodeFsArguments,
  NodeFsResult,
} from "../../NodeFsBackend.ts";
import { NodeFsSyscalls, type NodeFsSyscallTransport } from "./Calls.ts";
import { createRemoteFileMetadata } from "./Metadata.ts";
import { createRemoteFileIo } from "./Io.ts";
import { createRemoteDirectories } from "./Directories.ts";

export type NodeFsRemoteOperations = {
  [K in keyof NodeFsOperations]: (
    ...args: Parameters<NodeFsOperations[K]>
  ) => Promise<ReturnType<NodeFsOperations[K]>>;
};

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

/** Node's async file APIs use the existing bounded syscall capability, not a local filesystem. */
export function createNodeFsSyscallClient(options: {
  readonly syscalls: NodeFsSyscallTransport;
  readonly rootDescriptor: number;
  readonly posix: boolean;
  readonly signal?: AbortSignal;
}) {
  const calls = new NodeFsSyscalls(options.syscalls, options.rootDescriptor);
  const metadata = createRemoteFileMetadata(calls, options.posix);
  const io = createRemoteFileIo(
    calls,
    async (path) => (await metadata.lstat(path, options.signal)).type,
  );
  const directories = createRemoteDirectories(calls, io);
  const operations = { ...metadata, ...io, ...directories };
  return {
    ...operations,
    async call<K extends NodeFsOperation>(
      name: K,
      args: NodeFsArguments<K>,
      signal?: AbortSignal,
    ): Promise<NodeFsResult<K>> {
      const values: unknown[] = [...args];
      while (values.length < operands[name]) values.push(undefined);
      const combined =
        options.signal === undefined
          ? signal
          : signal === undefined
            ? options.signal
            : AbortSignal.any([options.signal, signal]);
      values.push(combined);
      return await Reflect.apply(operations[name], operations, values);
    },
  };
}
