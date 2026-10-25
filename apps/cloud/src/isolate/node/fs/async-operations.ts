import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { withNodeAbort } from "./abort.ts";
import {
  appendFileOperation,
  copyFileOperation,
  readFileOperation,
  writeFileOperation,
  readOptions,
  writeOptions,
} from "./files.ts";
import {
  linkOperation,
  mkdirOperation,
  mkdtempOperation,
  readdirOperation,
  renameOperation,
  rmOperation,
  rmdirOperation,
  symlinkOperation,
  unlinkOperation,
} from "./directories.ts";
import { readOperation, writeBufferOperation, writeStringOperation } from "./fd-ops.ts";
import { closeFdOperation, openFdAsyncOperation, writeAllOperation } from "./io.ts";
import {
  fstatOperation,
  fsyncOperation,
  ftruncateOperation,
  futimesOperation,
  lstatOperation,
  realpathOperation,
  readlinkOperation,
  statOperation,
  truncateOperation,
  utimesOperation,
} from "./metadata-ops.ts";
import { runAsync, type AsyncLeafRunner, type FsOperation } from "./operations.ts";
import { accessOperation, fchmodOperation } from "./permission-ops.ts";

export function createAsyncOperations(kernelFs: KernelFileSystem, runLeaf?: AsyncLeafRunner) {
  const bind =
    <Args extends unknown[], T>(
      operation: (kernelFs: KernelFileSystem, ...args: Args) => FsOperation<T>,
      signal?: (...args: Args) => AbortSignal | undefined,
    ) =>
    (...args: Args) => {
      const program = operation(kernelFs, ...args);
      const userSignal = signal?.(...args);
      return userSignal
        ? withNodeAbort(userSignal, (forwarded) => runAsync(program, runLeaf, forwarded))
        : runAsync(program, runLeaf);
    };

  return {
    access: bind(accessOperation),
    fchmod: bind(fchmodOperation),
    openFd: bind(openFdAsyncOperation),
    closeFd: bind(closeFdOperation),
    read: bind(readOperation),
    writeBuffer: bind(writeBufferOperation),
    writeString: bind(writeStringOperation),
    writeAll: bind(writeAllOperation),
    readFile: bind(
      (
        kernelFs,
        path: Parameters<typeof readFileOperation>[1],
        options: Parameters<typeof readFileOperation>[2],
      ) => readFileOperation(kernelFs, path, options, true),
      (
        _path: Parameters<typeof readFileOperation>[1],
        options: Parameters<typeof readFileOperation>[2],
      ) => readOptions(options).signal,
    ),
    writeFile: bind(
      (
        kernelFs,
        path: Parameters<typeof writeFileOperation>[1],
        data: Parameters<typeof writeFileOperation>[2],
        options: Parameters<typeof writeFileOperation>[3],
      ) => writeFileOperation(kernelFs, path, data, options, true),
      (
        _path: Parameters<typeof writeFileOperation>[1],
        _data: Parameters<typeof writeFileOperation>[2],
        options: Parameters<typeof writeFileOperation>[3],
      ) => writeOptions(options).signal,
    ),
    appendFile: bind(
      (
        kernelFs,
        path: Parameters<typeof appendFileOperation>[1],
        data: Parameters<typeof appendFileOperation>[2],
        options: Parameters<typeof appendFileOperation>[3],
      ) => appendFileOperation(kernelFs, path, data, options, true),
      (
        _path: Parameters<typeof appendFileOperation>[1],
        _data: Parameters<typeof appendFileOperation>[2],
        options: Parameters<typeof appendFileOperation>[3],
      ) => writeOptions(options).signal,
    ),
    copyFile: bind(
      (
        kernelFs,
        source: Parameters<typeof copyFileOperation>[1],
        destination: Parameters<typeof copyFileOperation>[2],
        flags: Parameters<typeof copyFileOperation>[3],
      ) => copyFileOperation(kernelFs, source, destination, flags, true),
    ),
    link: bind(linkOperation),
    mkdir: bind(mkdirOperation),
    mkdtemp: bind(mkdtempOperation),
    readdir: bind(readdirOperation),
    rename: bind(
      (
        kernelFs,
        source: Parameters<typeof renameOperation>[1],
        destination: Parameters<typeof renameOperation>[2],
      ) => renameOperation(kernelFs, source, destination, true),
    ),
    rm: bind(rmOperation),
    rmdir: bind(rmdirOperation),
    symlink: bind(symlinkOperation),
    unlink: bind(unlinkOperation),
    stat: bind(statOperation),
    lstat: bind(lstatOperation),
    fstat: bind(fstatOperation),
    realpath: bind(realpathOperation),
    readlink: bind(readlinkOperation),
    truncate: bind(truncateOperation),
    ftruncate: bind(ftruncateOperation),
    fsync: bind(fsyncOperation),
    utimes: bind(utimesOperation),
    futimes: bind(futimesOperation),
  };
}
