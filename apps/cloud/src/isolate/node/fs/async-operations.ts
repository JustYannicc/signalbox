import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { withNodeAbort } from "./abort.ts";
import { unsupportedFs } from "./errors.ts";
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
import { closeFdOperation, openFdOperation, writeAllOperation } from "./io.ts";
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
import {
  fsOperation,
  leaf,
  runAsync,
  type AsyncLeafRunner,
  type FsOperation,
} from "./operations.ts";
import { pathString, type PathLike } from "./path.ts";

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
    access: (path: PathLike, mode = 0) =>
      runAsync(
        (function* () {
          const name = pathString(path);
          if (mode !== 0) throw unsupportedFs("access", name);
          yield* fsOperation(
            "access",
            name,
            leaf(() => kernelFs.stat(name)),
          );
        })(),
        runLeaf,
      ),
    openFd: bind(openFdOperation),
    closeFd: bind(closeFdOperation),
    read: bind(readOperation),
    writeBuffer: bind(writeBufferOperation),
    writeString: bind(writeStringOperation),
    writeAll: bind(writeAllOperation),
    readFile: bind(readFileOperation, (_path, options) => readOptions(options).signal),
    writeFile: bind(writeFileOperation, (_path, _data, options) => writeOptions(options).signal),
    appendFile: bind(appendFileOperation, (_path, _data, options) => writeOptions(options).signal),
    copyFile: bind(copyFileOperation),
    link: bind(linkOperation),
    mkdir: bind(mkdirOperation),
    mkdtemp: bind(mkdtempOperation),
    readdir: bind(readdirOperation),
    rename: bind(renameOperation),
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
