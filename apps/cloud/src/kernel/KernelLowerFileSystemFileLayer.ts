import type { PosixMetadata } from "./PosixStorage.ts";
import type { Inode, Storage } from "./storage.ts";
import type { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";
import { basename, childPath, parentPath } from "./KernelLowerFileSystemSourceIndex.ts";
import type { KernelLowerFileSystemDirectoryLayer } from "./KernelLowerFileSystemDirectoryLayer.ts";
import type { KernelLowerFileSystemUpperStorage } from "./KernelLowerFileSystemUpperStorage.ts";
import { currentKernelSignal } from "./process/KernelExecution.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

const COPY_CHUNK_BYTES = 64 * 1024;

export class KernelLowerFileSystemFileLayer {
  readonly #upper: Storage;
  readonly #overlay: KernelLowerFileSystemUpperStorage["lowerOverlay"] | undefined;
  readonly #directories: KernelLowerFileSystemDirectoryLayer;
  readonly #source: () => KernelLowerFileSystemSourceIndex | undefined;
  readonly #upperByLowerInode = new Map<Inode, Inode>();
  readonly #references = new Map<Inode, number>();
  #nextStagingId = 0n;

  constructor(
    upper: Storage,
    overlay: KernelLowerFileSystemUpperStorage["lowerOverlay"] | undefined,
    directories: KernelLowerFileSystemDirectoryLayer,
    source: () => KernelLowerFileSystemSourceIndex | undefined,
  ) {
    this.#upper = upper;
    this.#overlay = overlay;
    this.#directories = directories;
    this.#source = source;
  }

  upperInodeForLower(inode: Inode): Inode | undefined {
    return this.#upperByLowerInode.get(inode);
  }

  retainLower(inode: Inode): void {
    const references = this.#references.get(inode) ?? 0;
    if (!Number.isSafeInteger(references + 1)) throw kernelError("EOVERFLOW");
    this.#references.set(inode, references + 1);
    const upper = this.#upperByLowerInode.get(inode);
    if (upper !== undefined) this.#upper.retain(upper);
  }

  releaseLower(inode: Inode): void {
    const references = this.#references.get(inode) ?? 0;
    if (references === 0) return;
    const upper = this.#upperByLowerInode.get(inode);
    if (upper !== undefined) this.#upper.release(upper);
    if (references === 1) {
      this.#references.delete(inode);
      this.#upperByLowerInode.delete(inode);
    } else this.#references.set(inode, references - 1);
  }

  async copyUpFile(inode: Inode, copyData: boolean): Promise<Inode> {
    const existing = this.#upperByLowerInode.get(inode);
    if (existing !== undefined) return existing;
    const source = this.#requireSource();
    const path = source.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    if (this.#overlay?.isLowerPathHidden(path)) throw kernelError("ENOENT");

    const signal = currentKernelSignal();
    signal?.throwIfAborted();
    const stat = await source.stat(inode, signal);
    if (stat.type !== "file") throw kernelError(stat.type === "directory" ? "EISDIR" : "EINVAL");
    const metadata = await source.metadata(inode, signal);
    const upperParent = await this.#upperParent(source, parentPath(path), signal);
    const existingUpper = this.#upperFileAt(upperParent, basename(path));
    if (existingUpper !== undefined) return this.#remember(inode, existingUpper);

    return this.#copyIntoStage(inode, path, upperParent, stat, metadata, copyData);
  }

  copyUpFileSync(inode: Inode): Inode {
    const existing = this.#upperByLowerInode.get(inode);
    if (existing !== undefined) return existing;
    const source = this.#requireSource();
    const path = source.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    if (this.#overlay?.isLowerPathHidden(path)) throw kernelError("ENOENT");
    const stat = source.stat(inode, currentKernelSignal());
    if (isPromiseLike(stat)) return this.#syncUnavailable(stat);
    if (stat.type !== "file") throw kernelError(stat.type === "directory" ? "EISDIR" : "EINVAL");
    const metadata = source.metadata(inode, currentKernelSignal());
    if (isPromiseLike(metadata)) return this.#syncUnavailable(metadata);
    const upperParent = this.#upperParentSync(source, parentPath(path));
    const existingUpper = this.#upperFileAt(upperParent, basename(path));
    if (existingUpper !== undefined) return this.#remember(inode, existingUpper);
    return this.#copyIntoStageSync(inode, path, upperParent, stat, metadata);
  }

  async renameLowerFile(
    inode: Inode,
    fromParent: Inode,
    fromName: string,
    toParent: Inode,
    toName: string,
  ): Promise<void> {
    const source = this.#requireSource();
    const fromParentPath = this.#directories.upperPath(fromParent);
    const toParentPath = this.#directories.upperPath(toParent);
    if (fromParentPath === undefined || toParentPath === undefined) throw kernelError("ENOTDIR");
    const fromPath = childPath(fromParentPath, fromName);
    const toPath = childPath(toParentPath, toName);
    if (fromPath === toPath) return;

    const signal = currentKernelSignal();
    signal?.throwIfAborted();
    const stat = await source.stat(inode, signal);
    if (stat.type !== "file") throw kernelError("EROFS");
    const metadata = await source.metadata(inode, signal);
    const stage = this.#createStage(fromParent, fromParentPath, fromPath, metadata);
    let published = false;
    try {
      await this.#copyContents(source, inode, stage.inode, stat.size, signal);
      await this.#upper.setTimes(stage.inode, {
        atimeNs: stat.atimeNs,
        mtimeNs: stat.mtimeNs,
      });
      signal?.throwIfAborted();
      const upperInode = this.#overlay!.publishStagingFile({
        stageParent: fromParent,
        stageName: stage.name,
        stagePath: stage.path,
        targetParent: toParent,
        targetName: toName,
        replaceExisting: true,
        hiddenLowerPath: fromPath,
      });
      published = true;
      this.#remember(inode, upperInode);
    } finally {
      try {
        if (!published) this.#discardStage(stage);
      } finally {
        this.#upper.release(stage.inode);
      }
    }
  }

  renameUpperFileWithWhiteout(
    fromParent: Inode,
    fromName: string,
    toParent: Inode,
    toName: string,
    lowerPath: string,
  ): void {
    if (this.#overlay === undefined) throw kernelError("ENOTSUP");
    this.#overlay.renameFileWithWhiteout(fromParent, fromName, toParent, toName, lowerPath);
  }

  unlinkUpperFileWithWhiteout(parent: Inode, name: string, lowerPath: string): void {
    if (this.#overlay === undefined) throw kernelError("ENOTSUP");
    this.#overlay.unlinkFileWithWhiteout(parent, name, lowerPath);
  }

  #copyIntoStage(
    lowerInode: Inode,
    path: string,
    upperParent: Inode,
    stat: { readonly size: bigint; readonly atimeNs: bigint; readonly mtimeNs: bigint },
    metadata: PosixMetadata,
    copyData: boolean,
  ): Promise<Inode> {
    return this.#copyIntoStageAsync(lowerInode, path, upperParent, stat, metadata, copyData);
  }

  async #copyIntoStageAsync(
    lowerInode: Inode,
    path: string,
    upperParent: Inode,
    stat: { readonly size: bigint; readonly atimeNs: bigint; readonly mtimeNs: bigint },
    metadata: PosixMetadata,
    copyData: boolean,
  ): Promise<Inode> {
    const parentPathValue = parentPath(path);
    const stage = this.#createStage(upperParent, parentPathValue, path, metadata);
    let published = false;
    try {
      if (copyData)
        await this.#copyContents(this.#requireSource(), lowerInode, stage.inode, stat.size);
      await this.#upper.setTimes(stage.inode, { atimeNs: stat.atimeNs, mtimeNs: stat.mtimeNs });
      currentKernelSignal()?.throwIfAborted();
      const upperInode = this.#overlay!.publishStagingFile({
        stageParent: upperParent,
        stageName: stage.name,
        stagePath: stage.path,
        targetParent: upperParent,
        targetName: basename(path),
        replaceExisting: false,
      });
      published = true;
      return this.#remember(lowerInode, upperInode);
    } finally {
      try {
        if (!published) this.#discardStage(stage);
      } finally {
        this.#upper.release(stage.inode);
      }
    }
  }

  #copyIntoStageSync(
    lowerInode: Inode,
    path: string,
    upperParent: Inode,
    stat: { readonly atimeNs: bigint; readonly mtimeNs: bigint },
    metadata: PosixMetadata,
  ): Inode {
    const stage = this.#createStage(upperParent, parentPath(path), path, metadata);
    let published = false;
    try {
      this.#upper.setTimes(stage.inode, { atimeNs: stat.atimeNs, mtimeNs: stat.mtimeNs });
      const upperInode = this.#overlay!.publishStagingFile({
        stageParent: upperParent,
        stageName: stage.name,
        stagePath: stage.path,
        targetParent: upperParent,
        targetName: basename(path),
        replaceExisting: false,
      });
      published = true;
      return this.#remember(lowerInode, upperInode);
    } finally {
      try {
        if (!published) this.#discardStage(stage);
      } finally {
        this.#upper.release(stage.inode);
      }
    }
  }

  async #copyContents(
    source: KernelLowerFileSystemSourceIndex,
    lowerInode: Inode,
    upperInode: Inode,
    size: bigint,
    signal = currentKernelSignal(),
  ): Promise<void> {
    const buffer = new Uint8Array(COPY_CHUNK_BYTES);
    let offset = 0n;
    while (offset < size) {
      signal?.throwIfAborted();
      const length = Number(
        size - offset < BigInt(buffer.byteLength) ? size - offset : BigInt(buffer.byteLength),
      );
      const target = buffer.subarray(0, length);
      const bytesRead = await source.readInto(lowerInode, offset, target);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length)
        throw kernelError("EIO", "Lower file returned an invalid byte count");
      if (bytesRead === 0) throw kernelError("EIO", "Lower file ended before its metadata size");

      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const written = await this.#upper.write(
          upperInode,
          offset + BigInt(bytesWritten),
          target.subarray(bytesWritten, bytesRead),
        );
        if (!Number.isInteger(written) || written <= 0 || written > bytesRead - bytesWritten)
          throw kernelError("EIO", "Upper file returned an invalid byte count");
        bytesWritten += written;
      }
      offset += BigInt(bytesRead);
    }
  }

  #createStage(
    parent: Inode,
    parentPathValue: string,
    targetPath: string,
    metadata: PosixMetadata,
  ) {
    if (this.#overlay === undefined) throw kernelError("ENOTSUP");
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = `.__signalbox_overlay_${this.#nextStagingId++}`;
      const path = childPath(parentPathValue, name);
      try {
        const inode = this.#overlay.createStagingFile(parent, name, path, metadata);
        return { inode, name, path };
      } catch (error) {
        if (!isCode(error, "EEXIST") || attempt === 2) throw error;
      }
    }
    throw kernelError("EIO", `Could not stage lower file copy-up for ${targetPath}`);
  }

  #discardStage(stage: {
    readonly inode: Inode;
    readonly name: string;
    readonly path: string;
  }): void {
    try {
      this.#overlay?.discardStagingFile(
        this.#upperParentOfStage(stage.path),
        stage.name,
        stage.path,
      );
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  #upperParentOfStage(path: string): Inode {
    const components = path.split("/").filter(Boolean);
    const name = components.pop();
    if (name === undefined) throw kernelError("EINVAL");
    let parent = this.#upper.root;
    for (const component of components) parent = this.#upper.lookup(parent, component);
    return parent;
  }

  async #upperParent(
    source: KernelLowerFileSystemSourceIndex,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Inode> {
    const existing = this.#directories.upperDirectoryAt(path);
    if (existing !== undefined) return existing;
    const lower = await source.lookup(path, signal);
    if (lower === undefined) throw kernelError("ENOENT");
    return this.#directories.copyUpDirectory(lower);
  }

  #upperParentSync(source: KernelLowerFileSystemSourceIndex, path: string): Inode {
    const existing = this.#directories.upperDirectoryAt(path);
    if (existing !== undefined) return existing;
    const lower = source.lookup(path, currentKernelSignal());
    if (isPromiseLike(lower)) return this.#syncUnavailable(lower);
    if (lower === undefined) throw kernelError("ENOENT");
    const upper = this.#directories.copyUpDirectory(lower);
    if (isPromiseLike(upper)) return this.#syncUnavailable(upper);
    return upper;
  }

  #upperFileAt(parent: Inode, name: string): Inode | undefined {
    try {
      const inode = this.#upper.lookup(parent, name);
      const stat = this.#upper.stat(inode);
      if (stat.type === "directory") throw kernelError("EISDIR");
      if (stat.type === "symlink") throw kernelError("ELOOP");
      return inode;
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  #remember(lowerInode: Inode, upperInode: Inode): Inode {
    if (this.#upperByLowerInode.has(lowerInode)) return this.#upperByLowerInode.get(lowerInode)!;
    const references = this.#references.get(lowerInode) ?? 0;
    for (let index = 0; index < references; index++) this.#upper.retain(upperInode);
    if (references > 0) this.#upperByLowerInode.set(lowerInode, upperInode);
    return upperInode;
  }

  #requireSource(): KernelLowerFileSystemSourceIndex {
    const source = this.#source();
    if (source === undefined) throw kernelError("ENOTSUP", "No lower filesystem is installed");
    return source;
  }

  #syncUnavailable<T>(value: Promise<T>): never {
    void value.catch(() => undefined);
    throw kernelError("ENOTSUP", "Lower file copy-up requires asynchronous execution");
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
