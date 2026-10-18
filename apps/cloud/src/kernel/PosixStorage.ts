import type { CreateOptions, Inode, Storage } from "./storage.ts";

/** File type stays in Stat.type; mode contains only permission and special bits. */
export interface PosixMetadata {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export const isPosixMetadata = (value: unknown): value is PosixMetadata => {
  if (typeof value !== "object" || value === null) return false;
  if (!("mode" in value) || !("uid" in value) || !("gid" in value)) return false;
  const id = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate < 0xffff_ffff;
  return (
    typeof value.mode === "number" &&
    Number.isInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o7777 &&
    id(value.uid) &&
    id(value.gid)
  );
};

/** Adapters apply credentials, umask and preserve-ID sentinels before entering storage. */
export interface PosixStorage extends Storage {
  readonly posix: {
    /** Unknown legacy metadata fails with ENOTSUP rather than inventing an owner. */
    get(inode: Inode): PosixMetadata;
    /** Explicit initialization of root or imported legacy metadata; known rows fail EEXIST. */
    initialize(inode: Inode, metadata: PosixMetadata): void;
    /** Atomic inode, metadata and retained pin. Opening an existing file preserves metadata. */
    create(
      parent: Inode,
      name: string,
      options: CreateOptions & { metadata: PosixMetadata },
    ): Inode;
    chmod(inode: Inode, mode: number): void;
    /** A regular file loses setuid/setgid when its owner or group changes. */
    chown(inode: Inode, owner: Pick<PosixMetadata, "uid" | "gid">): void;
  };
}
