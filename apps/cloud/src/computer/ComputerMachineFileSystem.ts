import { log } from "evlog";
import { MACHINE_FILES_MAX_CONTENT_BYTES } from "@signalbox/runner-protocol/MachineFilesProtocol";
import {
  KernelSynchronousFileBytesUnavailable,
  type KernelLowerFileSystemDirectoryEntry,
  type KernelLowerFileSystemDirectoryResult,
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "../kernel/KernelLowerFileSystem.ts";
import { machineFileMetadata } from "./MachineFileMetadata.ts";
import type { MachineFilesPort } from "./MachineFilesPort.ts";
import { indexMachinePrograms, type MachineProgramInventory } from "./MachineProgramInventory.ts";
import { liveSymlinkParents } from "./machineFiles/LiveSymlinkParents.ts";
import { machineFileRequest } from "./machineFiles/MachineFileRequest.ts";
import { createMachineImageContentReader } from "./MachineImageContent.ts";

export interface ComputerMachineFileSystemOptions {
  readonly inventory: MachineProgramInventory;
  readonly threadId?: string;
  readonly files: MachineFilesPort;
  readonly signal: AbortSignal;
}

/** Use the immutable image before a generation exists and while its attestation remains pristine. */
export function createComputerMachineFileSystem(
  options: ComputerMachineFileSystemOptions,
): KernelLowerFileSystemSource {
  const inventory = indexMachinePrograms(options.inventory);
  const imageContent = createMachineImageContentReader(options.inventory);
  const contentIsAuthoritative = (path: string) => {
    const state = options.files.current();
    return (
      imageIsAuthoritative(path) && (state.generation !== null || state.generationAbsent === true)
    );
  };
  const imageIsAuthoritative = (path: string) => {
    const state = options.files.current();
    const imageMatches =
      state.imageDigest === undefined || state.imageDigest === options.inventory.imageDigest;
    const noGeneration = state.generation === null && imageMatches;
    const pristineGeneration =
      state.pristine && state.imageDigest === options.inventory.imageDigest;
    return (noGeneration || pristineGeneration) && !inventory.isExcluded(path);
  };
  const runtimePathIsAbsent = (path: string, signal?: AbortSignal) => {
    options.signal.throwIfAborted();
    signal?.throwIfAborted();
    const state = options.files.current();
    return (
      state.generation === null && state.generationAbsent === true && inventory.isExcluded(path)
    );
  };
  const liveParents = (request: ReturnType<typeof machineFileRequest>) =>
    liveSymlinkParents({
      unavailable: request.unavailable,
      async lstat(path) {
        const result = await request.single({ id: "parent", op: "lstat", path });
        if ("error" in result) {
          if (absent(result.error.code))
            throw request.unavailable("Machine symlink parent disappeared during lookup");
          throw posixError(result.error);
        }
        if (result.op !== "lstat")
          throw request.unavailable("Machine returned the wrong ancestor operation");
        return result.stat;
      },
      async readlink(path) {
        try {
          return await request.readlink(path);
        } catch (error) {
          if (error instanceof Error && "code" in error && absent(String(error.code)))
            throw request.unavailable("Machine ancestor symlink disappeared during lookup", {
              cause: error,
            });
          throw error;
        }
      },
    });
  return {
    lookupKnown(paths) {
      options.signal.throwIfAborted();
      if (paths.some((path) => !imageIsAuthoritative(path) && !runtimePathIsAbsent(path)))
        return undefined;
      return inventory
        .lookup(paths)
        .map((entry, index) =>
          entry === undefined ? undefined : machineFileMetadata(paths[index]!, entry),
        );
    },
    readdirKnown(path) {
      options.signal.throwIfAborted();
      if (!imageIsAuthoritative(path)) return undefined;
      return inventory.readdir(path)?.map((entry) => machineFileDirectoryEntry(entry.path, entry));
    },
    readlinkKnown(path) {
      options.signal.throwIfAborted();
      if (!imageIsAuthoritative(path)) return undefined;
      return inventory.readlink(path);
    },
    async lookup(paths, signal) {
      const request = machineFileRequest(options.files, options.signal, signal);
      const parent = liveParents(request);
      const captured = paths.map((path) => ({
        path,
        image: imageIsAuthoritative(path) || runtimePathIsAbsent(path),
      }));
      const imagePaths = captured.filter((entry) => entry.image).map((entry) => entry.path);
      const image = imagePaths.length === 0 ? [] : inventory.lookup(imagePaths);
      const live = captured.filter((entry) => !entry.image);
      const results = await request.batch(
        live.map(({ path }, index) => ({ id: String(index), op: "lstat", path })),
      );
      let imageIndex = 0;
      let liveIndex = 0;
      const entries: (KernelLowerFileSystemEntry | undefined)[] = [];
      for (const { path, image: useImage } of captured) {
        if (useImage) {
          const entry = image[imageIndex++];
          entries.push(entry === undefined ? undefined : machineFileMetadata(path, entry));
          continue;
        }
        const result = results[liveIndex++];
        if (result === undefined) throw request.unavailable("Machine file response is incomplete");
        if ("error" in result) {
          if (absent(result.error.code)) {
            entries.push(undefined);
            continue;
          }
          throw posixError(result.error);
        }
        if (result.op !== "lstat")
          throw request.unavailable("Machine returned the wrong file operation");
        const symlinkParent = result.stat.type === "symlink" ? await parent(path) : undefined;
        entries.push(
          machineFileMetadata(path, {
            ...result.stat,
            ...(symlinkParent === undefined ? {} : { symlinkParent }),
          }),
        );
      }
      request.check();
      return entries;
    },
    async readdir(path, signal) {
      if (runtimePathIsAbsent(path, signal)) return undefined;
      if (imageIsAuthoritative(path) && !inventory.needsLiveDirectory(path))
        return inventory.readdir(path)?.map((entry) => machineFileMetadata(entry.path, entry));
      const entries: KernelLowerFileSystemDirectoryEntry[] = [];
      const request = machineFileRequest(options.files, options.signal, signal);
      const parent = liveParents(request);
      let cursor: string | undefined;
      do {
        const result = await request.single({
          id: "directory",
          op: "readdir",
          path,
          withStat: true,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if ("error" in result) {
          if (absent(result.error.code)) return undefined;
          throw posixError(result.error);
        }
        if (result.op !== "readdir")
          throw request.unavailable("Machine returned the wrong directory operation");
        for (const entry of result.entries) {
          if (entry.stat === undefined)
            throw request.unavailable("Machine omitted directory metadata");
          const child = `${path === "/" ? "" : path}/${entry.name}`;
          const symlinkParent = entry.stat.type === "symlink" ? await parent(child) : undefined;
          entries.push(
            machineFileDirectoryEntry(child, {
              ...entry.stat,
              ...(symlinkParent === undefined ? {} : { symlinkParent }),
            }),
          );
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor !== undefined);
      request.check();
      return entries;
    },
    async readdirMany(paths, signal) {
      if (paths.length === 0) return [];
      const request = machineFileRequest(options.files, options.signal, signal);
      const parent = liveParents(request);
      const routes = paths.map((path) => {
        if (runtimePathIsAbsent(path, signal)) return { kind: "absent" as const };
        if (imageIsAuthoritative(path) && !inventory.needsLiveDirectory(path)) {
          return { kind: "image" as const, entries: inventory.readdir(path) };
        }
        return { kind: "live" as const };
      });
      const entriesByPath: KernelLowerFileSystemDirectoryResult[] = routes.map((route) =>
        route.kind !== "image" || route.entries === undefined
          ? undefined
          : {
              kind: "entries",
              entries: route.entries.map((entry) => machineFileDirectoryEntry(entry.path, entry)),
            },
      );
      const collectedByPath: Array<KernelLowerFileSystemDirectoryEntry[] | undefined> = routes.map(
        (route) => (route.kind === "live" ? [] : undefined),
      );
      let remaining: Array<{ path: string; index: number; cursor?: string }> = paths.flatMap(
        (path, index) => (routes[index]?.kind === "live" ? [{ path, index }] : []),
      );
      let nextId = 0;
      while (remaining.length > 0) {
        const operations = remaining.map(({ path, cursor }) => ({
          id: String(nextId++),
          op: "readdir" as const,
          path,
          withStat: true,
          ...(cursor === undefined ? {} : { cursor }),
        }));
        const results = await request.batch(operations);
        const next: Array<{ path: string; index: number; cursor?: string }> = [];
        for (let offset = 0; offset < remaining.length; offset++) {
          const current = remaining[offset];
          const result = results[offset];
          if (current === undefined || result === undefined)
            throw request.unavailable("Machine directory batch response is incomplete");
          if ("error" in result) {
            if (result.error.code === "EACCES") {
              collectedByPath[current.index] = undefined;
              entriesByPath[current.index] = { kind: "error", error: posixError(result.error) };
              continue;
            }
            if (absent(result.error.code) && current.cursor === undefined) {
              collectedByPath[current.index] = undefined;
              entriesByPath[current.index] = undefined;
              continue;
            }
            throw posixError(result.error);
          }
          if (result.op !== "readdir")
            throw request.unavailable("Machine returned the wrong directory operation");
          for (const entry of result.entries) {
            if (entry.stat === undefined)
              throw request.unavailable("Machine omitted directory metadata");
            const child = `${current.path === "/" ? "" : current.path}/${entry.name}`;
            const symlinkParent = entry.stat.type === "symlink" ? await parent(child) : undefined;
            collectedByPath[current.index]!.push(
              machineFileDirectoryEntry(child, {
                ...entry.stat,
                ...(symlinkParent === undefined ? {} : { symlinkParent }),
              }),
            );
          }
          if (result.nextCursor !== null)
            next.push({ path: current.path, index: current.index, cursor: result.nextCursor });
        }
        remaining = next;
      }
      request.check();
      for (let index = 0; index < paths.length; index++) {
        const entries = collectedByPath[index];
        if (entries !== undefined) entriesByPath[index] = { kind: "entries", entries };
      }
      return entriesByPath;
    },
    async readlink(path, signal) {
      if (runtimePathIsAbsent(path, signal))
        throw posixError({ code: "ENOENT", message: "Machine runtime path is absent" });
      if (imageIsAuthoritative(path)) {
        const target = inventory.readlink(path);
        if (target !== undefined) return target;
        throw posixError({ code: "EINVAL", message: "Machine path is not a symbolic link" });
      }
      return machineFileRequest(options.files, options.signal, signal).readlink(path);
    },
    async readlinkMany(paths, signal) {
      if (paths.length === 0) return [];
      const request = machineFileRequest(options.files, options.signal, signal);
      const captured = paths.map((path) => {
        if (runtimePathIsAbsent(path, signal))
          throw posixError({ code: "ENOENT", message: "Machine runtime path is absent" });
        return { path, image: imageIsAuthoritative(path) };
      });
      const live = captured.filter(({ image }) => !image);
      const results = await request.batch(
        live.map(({ path }, index) => ({ id: String(index), op: "readlink" as const, path })),
      );
      let liveIndex = 0;
      const targets = captured.map(({ path, image: useImage }) => {
        if (useImage) return inventory.readlink(path);
        const result = results[liveIndex++];
        if (result === undefined) throw request.unavailable("Machine link response is incomplete");
        if ("error" in result) throw posixError(result.error);
        if (result.op !== "readlink")
          throw request.unavailable("Machine returned the wrong link operation");
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(
            decodeBase64(result.targetBase64),
          );
        } catch (cause) {
          throw request.unavailable("Machine returned an invalid link target", { cause });
        }
      });
      request.check();
      return targets;
    },
    readKnown(path, offset, length) {
      const request = machineFileRequest(options.files, options.signal);
      request.check();
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER))
        throw posixError({ code: "EOVERFLOW", message: "Invalid machine file offset" });
      if (!Number.isSafeInteger(length) || length < 0)
        throw posixError({ code: "EINVAL", message: "Invalid machine file read length" });
      const bytes = contentIsAuthoritative(path)
        ? imageContent.readKnown(
            path,
            Number(offset),
            Math.min(length, MACHINE_FILES_MAX_CONTENT_BYTES),
          )
        : undefined;
      request.check();
      if (bytes !== undefined && contentIsAuthoritative(path)) return bytes;
      // Count failures even when guest code catches the error and the command succeeds.
      log.warn({
        action: "computer.filesystem.sync_bytes_unavailable",
        count: 1,
        thread: options.threadId === undefined ? undefined : { id: options.threadId },
      });
      const context = request.unavailable("Synchronous image content is unavailable", undefined, [
        { id: "bytes", op: "readRange", path, offset: Number(offset), length },
      ]).filesystemContext;
      throw new KernelSynchronousFileBytesUnavailable(
        path,
        context === undefined ? undefined : { filesystemContext: context },
      );
    },
    async read(path, offset, length, signal) {
      const request = machineFileRequest(options.files, options.signal, signal);
      request.check();
      if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER))
        throw posixError({
          code: "EOVERFLOW",
          message: "Machine file offset is outside the supported range",
        });
      if (!Number.isSafeInteger(length) || length < 0)
        throw posixError({ code: "EINVAL", message: "Invalid machine file read length" });
      const boundedLength = Math.min(length, MACHINE_FILES_MAX_CONTENT_BYTES);
      const operation = {
        id: "bytes",
        op: "readRange",
        path,
        offset: Number(offset),
        length: boundedLength,
      } as const;
      request.check([operation]);
      if (contentIsAuthoritative(path)) {
        let bytes: Uint8Array | undefined;
        try {
          bytes = await imageContent(path, Number(offset), boundedLength);
        } catch (cause) {
          request.check([operation]);
          throw request.unavailable("Image content validation failed", { cause }, [operation]);
        }
        request.check([operation]);
        if (bytes !== undefined && contentIsAuthoritative(path)) return bytes;
      }
      const result = await request.single(operation);
      if ("error" in result) throw posixError(result.error);
      if (result.op !== "readRange")
        throw request.unavailable("Machine returned the wrong read operation");
      const bytes = decodeBase64(result.bytesBase64);
      if (bytes.byteLength !== result.bytesRead)
        throw request.unavailable("Machine file byte count does not match its payload");
      return bytes;
    },
  };
}

function absent(code: string) {
  return code === "ENOENT" || code === "ENOTDIR";
}

function posixError(error: { readonly code: string; readonly message: string }) {
  return Object.assign(new Error(error.message), { code: error.code });
}

function machineFileDirectoryEntry(
  path: string,
  metadata: Parameters<typeof machineFileMetadata>[1],
): KernelLowerFileSystemDirectoryEntry {
  if (metadata.type !== "file" && metadata.type !== "directory" && metadata.type !== "symlink")
    return { path, unsupportedType: metadata.type };
  return machineFileMetadata(path, metadata);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
