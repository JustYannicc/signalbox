import type { PosixMetadata, PosixStorage } from "../PosixStorage.ts";
import type { CreateOptions, Inode, Storage } from "../storage.ts";
import type { WasiMountedStorage } from "../wasi/internal_wasi_paths.ts";
import { kernelError, runKernelSync, withKernelErrors } from "./KernelFileSystemErrors.ts";
import type {
  KernelPosixCredentials,
  KernelPosixOptions,
  KernelStat,
} from "./KernelFileSystemTypes.ts";

const MAX_ID = 0xffff_fffe;
const MODE_MASK = 0o7777;
const UMASK_MASK = 0o777;

/** Per-process POSIX identity, umask, and metadata operations for the shared inode store. */
export class KernelPosix {
  readonly #credentials: KernelPosixCredentials | undefined;
  #umask: number;
  #nextCreateMode: number | undefined;

  constructor(options?: KernelPosixOptions) {
    if (options === undefined) {
      this.#credentials = undefined;
      this.#umask = 0;
      return;
    }
    validatePolicy(options);
    this.#credentials = freezeCredentials(options.credentials);
    this.#umask = options.umask;
  }

  get credentials(): KernelPosixCredentials | undefined {
    return this.#credentials === undefined ? undefined : freezeCredentials(this.#credentials);
  }

  get policy(): KernelPosixOptions | undefined {
    return this.#credentials === undefined
      ? undefined
      : Object.freeze({ credentials: this.credentials!, umask: this.#umask });
  }

  setUmask(mask: number): number {
    if (this.#credentials === undefined) throw kernelError("ENOTSUP");
    validateMode(mask, UMASK_MASK);
    const previous = this.#umask;
    this.#umask = mask;
    return previous;
  }

  setNextCreateMode(mode: number): void {
    if (this.#credentials === undefined) throw kernelError("ENOTSUP");
    validateMode(mode, MODE_MASK);
    this.#nextCreateMode = mode;
  }

  takeNextCreateMode(): number | undefined {
    const mode = this.#nextCreateMode;
    this.#nextCreateMode = undefined;
    return mode;
  }

  createInode(
    mount: WasiMountedStorage,
    parent: Inode,
    name: string,
    options: CreateOptions,
    mode?: number,
  ): Inode {
    return withKernelErrors(() => {
      if (mount.readOnly) throw kernelError("EROFS");
      const storage = mount.storage as Storage;
      if (this.#credentials === undefined) {
        return runKernelSync(storage.create(parent, name, options));
      }

      validateMode(mode ?? defaultCreateMode(options.type), MODE_MASK);
      const posix = requirePosixStorage(storage);
      const requestedMode = mode ?? defaultCreateMode(options.type);
      const effectiveMode =
        options.type === "symlink" ? 0o777 : requestedMode & ~this.#umask & MODE_MASK;
      const metadata: PosixMetadata = {
        mode: effectiveMode,
        uid: this.#credentials.euid,
        gid: this.#credentials.egid,
      };
      return runKernelSync(
        posix.create(parent, name, {
          ...options,
          metadata,
        }),
      );
    });
  }

  getMetadata(storage: WasiMountedStorage["storage"], inode: Inode): PosixMetadata {
    return withKernelErrors(() => runKernelSync(requirePosixStorage(storage).get(inode)));
  }

  checkAccess(
    storage: WasiMountedStorage["storage"],
    inode: Inode,
    type: KernelStat["type"],
    requested: number,
    effectiveIds: boolean,
  ): void {
    const credentials = this.#requireCredentials();
    const metadata = this.getMetadata(storage, inode);
    const uid = effectiveIds ? credentials.euid : credentials.uid;
    const gid = effectiveIds ? credentials.egid : credentials.gid;

    if (uid === 0) {
      // Linux root may traverse directories but still needs an execute bit on files.
      if (type !== "directory" && (requested & 1) !== 0 && (metadata.mode & 0o111) === 0) {
        throw kernelError("EACCES");
      }
      return;
    }

    const groups = credentials.groups ?? [];
    const shift =
      uid === metadata.uid ? 6 : gid === metadata.gid || groups.includes(metadata.gid) ? 3 : 0;
    const allowed = (metadata.mode >>> shift) & 7;
    if ((allowed & requested) !== requested) throw kernelError("EACCES");
  }

  chmod(storage: WasiMountedStorage, inode: Inode, mode: number): void {
    withKernelErrors(() => {
      if (storage.readOnly) throw kernelError("EROFS");
      if (this.#credentials === undefined) throw kernelError("ENOTSUP");
      validateMode(mode, MODE_MASK);
      const posix = requirePosixStorage(storage.storage);
      this.#requireOwnerOrRoot(posix.get(inode));
      runKernelSync(posix.chmod(inode, mode));
    });
  }

  chown(storage: WasiMountedStorage, inode: Inode, uid: number, gid: number): void {
    withKernelErrors(() => {
      if (storage.readOnly) throw kernelError("EROFS");
      const credentials = this.#requireCredentials();
      validateId(uid);
      validateId(gid);
      const posix = requirePosixStorage(storage.storage);
      const metadata = runKernelSync(posix.get(inode));
      if (credentials.euid !== 0) {
        if (credentials.euid !== metadata.uid || uid !== metadata.uid) {
          throw kernelError("EPERM");
        }
        const groups = credentials.groups ?? [];
        if (gid !== metadata.gid && gid !== credentials.egid && !groups.includes(gid)) {
          throw kernelError("EPERM");
        }
      }
      runKernelSync(posix.chown(inode, { uid, gid }));
    });
  }

  #requireOwnerOrRoot(metadataResult: PosixMetadata | Promise<PosixMetadata>): void {
    const credentials = this.#requireCredentials();
    const metadata = runKernelSync(metadataResult);
    if (credentials.euid !== 0 && credentials.euid !== metadata.uid) {
      throw kernelError("EPERM");
    }
  }

  #requireCredentials(): KernelPosixCredentials {
    if (this.#credentials === undefined) throw kernelError("ENOTSUP");
    return this.#credentials;
  }
}

function requirePosixStorage(storage: unknown): PosixStorage["posix"] {
  if (typeof storage !== "object" || storage === null || !("posix" in storage)) {
    throw kernelError("ENOTSUP");
  }
  const posix = (storage as PosixStorage).posix;
  if (typeof posix !== "object" || posix === null) throw kernelError("ENOTSUP");
  return posix;
}

function defaultCreateMode(type: CreateOptions["type"]): number {
  return type === "directory" ? 0o777 : 0o666;
}

function validatePolicy(options: KernelPosixOptions): void {
  const { credentials } = options;
  for (const id of [credentials.uid, credentials.gid, credentials.euid, credentials.egid]) {
    validateId(id);
  }
  for (const group of credentials.groups ?? []) validateId(group);
  validateMode(options.umask, UMASK_MASK);
}

function validateId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_ID) throw kernelError("EINVAL");
}

function validateMode(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw kernelError("EINVAL");
}

function freezeCredentials(credentials: KernelPosixCredentials): KernelPosixCredentials {
  return Object.freeze({
    uid: credentials.uid,
    gid: credentials.gid,
    euid: credentials.euid,
    egid: credentials.egid,
    ...(credentials.groups === undefined ? {} : { groups: Object.freeze([...credentials.groups]) }),
  });
}
