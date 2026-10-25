// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
  DirectoryEntry,
  Inode,
  MaybeAsyncStorage,
  MaybePromise,
  Mount,
  Stat,
} from "../storage.ts";
import { WasiError } from "./internal_wasi_memory.ts";
import { complete, mapErrno, type WasiCall } from "./internal_wasi_calls.ts";

const EINVAL = 28;
const ELOOP = 32;
const ENOENT = 44;
const ENAMETOOLONG = 37;
const ENOTCAPABLE = 76;
const ENOTDIR = 54;
const ESTALE = 72;
const MAX_SYMLINKS = 40;
const MAX_PATH_BYTES = 4096;

const encoder = new TextEncoder();

export type WasiStorage = MaybeAsyncStorage;

/** Optional edge check keeps upper-only directory anchors independent of lower I/O. */
export interface WasiDirectoryEdgeStorage {
  directoryEntry(parent: Inode, child: Inode): MaybePromise<DirectoryEntry | undefined>;
}

/** An overlay may expose a lower symlink through a different logical directory. */
export interface WasiSymlinkParentStorage {
  symlinkParent(inode: Inode): string | undefined;
}

export interface WasiMountedStorage {
  readonly id: number;
  readonly path: string;
  readonly storage: WasiStorage;
  readonly root: Inode;
  readonly readOnly: boolean;
  readonly device: bigint;
}

export interface WasiPathAnchor {
  readonly mount: WasiMountedStorage;
  readonly inode: Inode;
  /** Directory inodes from the preopen root through this directory. */
  readonly ancestors: readonly Inode[];
  /** Directory names from the preopen root through this directory. */
  readonly pathComponents: readonly string[];
}

export type WasiPathSearchCheck = (
  mount: WasiMountedStorage,
  directory: Inode,
) => MaybePromise<void>;
export type WasiPathCheck = (mount: WasiMountedStorage, components: readonly string[]) => void;
// signalbox: a kernel device can terminate a missing lookup without inventing a storage inode.
export type WasiMissingPathCheck = (
  parent: WasiPathAnchor,
  name: string,
  remaining: readonly string[],
  requireDirectory: boolean,
) => void;

export interface WasiResolvedPath {
  readonly mount: WasiMountedStorage;
  readonly inode: Inode;
  readonly stat: Stat;
  /** Present when the result names a child of the capability root. */
  readonly parent?: Inode;
  readonly name?: string;
  /** Includes the final name for files and symlinks. */
  readonly pathComponents: readonly string[];
  /** Includes the final inode only when the result is a directory. */
  readonly ancestors: readonly Inode[];
}

export interface WasiResolvedParent {
  readonly mount: WasiMountedStorage;
  readonly parent: Inode;
  readonly name: string;
  readonly pathComponents: readonly string[];
  readonly ancestors: readonly Inode[];
}

export type WasiPathLookup =
  | { readonly kind: "existing"; readonly path: WasiResolvedPath }
  | { readonly kind: "missing"; readonly parent: WasiResolvedParent };

export function normalizeMounts(mounts: Mount<WasiStorage>[]): WasiMountedStorage[] {
  const paths = new Set<string>();
  return mounts.map((mount, id) => {
    const path = normalizeMountPath(mount.path);
    if (paths.has(path)) throw new WasiError(EINVAL);
    paths.add(path);
    return {
      id,
      path,
      storage: mount.storage,
      root: mount.root ?? mount.storage.root,
      readOnly: mount.readOnly ?? false,
      device: BigInt(id + 1),
    };
  });
}

export class WasiPathResolver {
  readonly #complete: typeof complete;
  // signalbox: personality mount overlays must reject hidden entries before traversal.
  readonly #checkPath: WasiPathCheck | undefined;
  readonly #missingPath: WasiMissingPathCheck | undefined;

  constructor(
    completeCall: typeof complete,
    checkPath?: WasiPathCheck,
    missingPath?: WasiMissingPathCheck,
  ) {
    this.#complete = completeCall;
    this.#checkPath = checkPath;
    this.#missingPath = missingPath;
  }

  /** Validates the recorded parent chain and returns its current names. */
  *validateAnchor(base: WasiPathAnchor): WasiCall<WasiPathAnchor> {
    const { mount, inode, ancestors } = base;
    if (
      ancestors.length !== base.pathComponents.length + 1 ||
      ancestors[0] !== mount.root ||
      ancestors[ancestors.length - 1] !== inode
    ) {
      throw new WasiError(EINVAL);
    }
    const pathComponents: string[] = [];
    this.#checkPath?.(mount, pathComponents);
    for (let index = 1; index < ancestors.length; index++) {
      const parent = ancestors[index - 1];
      const child = ancestors[index];
      if (parent === undefined || child === undefined) throw new WasiError(EINVAL);
      let entry: DirectoryEntry | undefined;
      try {
        entry = yield* this.#directoryEntry(mount, parent, child);
      } catch (error) {
        const errno = mapErrno(error);
        if (errno === ENOENT || errno === ENOTDIR || errno === ESTALE) {
          throw new WasiError(ESTALE);
        }
        throw error;
      }
      // Storage has no authoritative parent lookup. A moved or unlinked edge
      // cannot be used to reconstruct a path inside this capability.
      if (entry === undefined) throw new WasiError(ESTALE);
      pathComponents.push(entry.name);
      this.#checkPath?.(mount, pathComponents);
    }
    return { mount, inode, ancestors: [...ancestors], pathComponents };
  }

  *resolve(
    base: WasiPathAnchor,
    path: string,
    followFinalSymlink: boolean,
    checkSearch?: WasiPathSearchCheck,
  ): WasiCall<WasiResolvedPath> {
    const result = yield* this.resolveOrCreate(base, path, followFinalSymlink, checkSearch);
    if (result.kind === "missing") throw new WasiError(ENOENT);
    return result.path;
  }

  /** Resolves existing entries or returns the confined parent for a missing leaf. */
  *resolveOrCreate(
    base: WasiPathAnchor,
    path: string,
    followFinalSymlink: boolean,
    checkSearch?: WasiPathSearchCheck,
  ): WasiCall<WasiPathLookup> {
    const pending = parseRelativePath(path);
    let requireDirectory = pathRequiresDirectory(path);
    const validated = yield* this.validateAnchor(base);
    const ancestors = [...validated.ancestors];
    const pathComponents = [...validated.pathComponents];
    let current = ancestors[ancestors.length - 1];
    if (current === undefined) throw new WasiError(EINVAL);

    let symlinkDepth = 0;
    let index = 0;

    while (index < pending.length) {
      const name = pending[index++];
      if (name === undefined) continue;
      if (name === "") continue;
      if (name === ".") {
        if (checkSearch !== undefined) {
          yield* this.#complete(checkSearch(base.mount, current));
        }
        continue;
      }
      if (name === "..") {
        if (checkSearch !== undefined) {
          yield* this.#complete(checkSearch(base.mount, current));
        }
        if (pathComponents.length === 0 || ancestors.length <= 1) {
          throw new WasiError(ENOTCAPABLE);
        }
        const parent = ancestors[ancestors.length - 2];
        if (parent === undefined) throw new WasiError(ENOTCAPABLE);
        // Route snapshots cannot establish a directory's parent after a move.
        // Reject a stale edge instead of resolving under the old parent.
        if ((yield* this.#directoryEntry(base.mount, parent, current)) === undefined) {
          throw new WasiError(ESTALE);
        }
        pathComponents.pop();
        ancestors.pop();
        current = parent;
        continue;
      }

      const parentStat = yield* this.#complete(base.mount.storage.stat(current));
      if (parentStat.type !== "directory") throw new WasiError(ENOTDIR);
      if (checkSearch !== undefined) {
        yield* this.#complete(checkSearch(base.mount, current));
      }

      const isLast = index === pending.length;
      this.#checkPath?.(base.mount, [...pathComponents, name]);
      let inode: Inode;
      try {
        inode = yield* this.#complete(base.mount.storage.lookup(current, name));
      } catch (error) {
        if (isErrno(error, ENOENT)) {
          this.#missingPath?.(
            { mount: base.mount, inode: current, ancestors, pathComponents },
            name,
            pending.slice(index),
            requireDirectory,
          );
        }
        if (isLast && !requireDirectory && isErrno(error, ENOENT)) {
          return {
            kind: "missing",
            parent: {
              mount: base.mount,
              parent: current,
              name,
              pathComponents: [...pathComponents, name],
              ancestors,
            },
          };
        }
        throw error;
      }
      const stat = yield* this.#complete(base.mount.storage.stat(inode));
      const followSymlink =
        stat.type === "symlink" && (!isLast || followFinalSymlink || requireDirectory);

      if (followSymlink) {
        if (++symlinkDepth > MAX_SYMLINKS) throw new WasiError(ELOOP);
        const target = yield* this.#complete(base.mount.storage.readlink(inode));
        if (target.length === 0 || target.includes("\0")) throw new WasiError(EINVAL);
        const storage = base.mount.storage as WasiStorage & Partial<WasiSymlinkParentStorage>;
        const parentPath = target.startsWith("/") ? undefined : storage.symlinkParent?.(inode);
        if (target.startsWith("/") || parentPath !== undefined) {
          ancestors.splice(1);
          pathComponents.length = 0;
          const root = ancestors[0];
          if (root === undefined) throw new WasiError(ENOTCAPABLE);
          current = root;
        }
        if (isLast) requireDirectory ||= pathRequiresDirectory(target);
        const targetSegments = [
          ...(parentPath === undefined ? [] : parseSymlinkTarget(parentPath)),
          ...parseSymlinkTarget(target),
        ];
        pending.splice(index - 1, 1, ...targetSegments);
        index--;
        continue;
      }

      const nextPathComponents = [...pathComponents, name];
      if (isLast) {
        if (requireDirectory && stat.type !== "directory") {
          throw new WasiError(ENOTDIR);
        }
        return {
          kind: "existing",
          path: {
            mount: base.mount,
            inode,
            stat,
            parent: current,
            name,
            pathComponents: nextPathComponents,
            ancestors: stat.type === "directory" ? [...ancestors, inode] : ancestors,
          },
        };
      }

      if (stat.type !== "directory") throw new WasiError(ENOTDIR);
      current = inode;
      ancestors.push(inode);
      pathComponents.push(name);
    }

    const stat = yield* this.#complete(base.mount.storage.stat(current));
    if (requireDirectory && stat.type !== "directory") throw new WasiError(ENOTDIR);
    return {
      kind: "existing",
      path: {
        mount: base.mount,
        inode: current,
        stat,
        pathComponents,
        ancestors,
      },
    };
  }

  *#directoryEntry(
    mount: WasiMountedStorage,
    parent: Inode,
    child: Inode,
  ): WasiCall<DirectoryEntry | undefined> {
    const storage = mount.storage as WasiStorage & Partial<WasiDirectoryEdgeStorage>;
    if (typeof storage.directoryEntry === "function") {
      return yield* this.#complete(storage.directoryEntry(parent, child));
    }
    const entries = yield* this.#complete(storage.readdir(parent));
    return entries.find((entry) => entry.inode === child && entry.type === "directory");
  }

  *resolveParent(base: WasiPathAnchor, path: string): WasiCall<WasiResolvedParent> {
    const segments = parseRelativePath(path);
    while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
    const name = segments.pop();
    if (name === undefined || name === "" || name === "." || name === "..") {
      throw new WasiError(EINVAL);
    }

    const parentPath = segments.join("/");
    const resolved = yield* this.resolve(base, parentPath || ".", true);
    if (resolved.stat.type !== "directory") throw new WasiError(ENOTDIR);
    this.#checkPath?.(base.mount, [...resolved.pathComponents, name]);
    return {
      mount: base.mount,
      parent: resolved.inode,
      name,
      pathComponents: [...resolved.pathComponents, name],
      ancestors: resolved.ancestors,
    };
  }
}

function normalizeMountPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) throw new WasiError(EINVAL);
  const segments = path.split("/").filter((segment) => segment !== "");
  validatePathLength(path);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WasiError(EINVAL);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function parseRelativePath(path: string): string[] {
  if (path.startsWith("/")) throw new WasiError(ENOTCAPABLE);
  if (path.includes("\0")) throw new WasiError(EINVAL);
  if (path.length === 0) throw new WasiError(ENOENT);
  const segments = path.split("/");
  validatePathLength(path);
  return segments;
}

function parseSymlinkTarget(target: string): string[] {
  const relative = target.startsWith("/") ? target.slice(1) : target;
  const segments = relative.split("/");
  validatePathLength(target);
  return segments;
}

function pathRequiresDirectory(path: string): boolean {
  return path.endsWith("/") || path.endsWith("/.") || path.endsWith("/..");
}

function validatePathLength(path: string): void {
  if (encoder.encode(path).byteLength > MAX_PATH_BYTES) {
    throw new WasiError(ENAMETOOLONG);
  }
}

function isErrno(error: unknown, errno: number): boolean {
  if (error instanceof WasiError) return error.errno === errno;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return String(error.code) === "ENOENT";
}
