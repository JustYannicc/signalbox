import type { PosixMetadata, PosixStorage } from "./PosixStorage.ts";

const marker = "posix-metadata-proof";
const persisted = { mode: 0o640, uid: 0xffff_fffe, gid: 0x8000_0000 };
const policy = { mode: 0o644, uid: 1001, gid: 1002 };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: PosixMetadata, expected: PosixMetadata) {
  assert(
    actual.mode === expected.mode && actual.uid === expected.uid && actual.gid === expected.gid,
    "POSIX metadata differs from the explicit policy",
  );
}

function errno(action: () => unknown, expected: string) {
  try {
    action();
  } catch (error) {
    assert(
      error instanceof Error && "code" in error && error.code === expected,
      `Expected ${expected}`,
    );
    return;
  }
  throw new Error(`Expected ${expected}`);
}

function remove(fs: PosixStorage, name: string) {
  try {
    fs.unlink(fs.root, name, { directory: false });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/** Same inode operations in Node tests, local workerd and the deployed facet. */
export function runPosixStorageProof(fs: PosixStorage) {
  for (const name of [marker, "posix-alias", "posix-legacy", "posix-link"]) remove(fs, name);
  try {
    fs.posix.get(fs.root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOTSUP")) throw error;
    fs.posix.initialize(fs.root, { ...policy, mode: 0o755 });
  }
  same(fs.posix.get(fs.root), { ...policy, mode: 0o755 });

  const retained: bigint[] = [];
  try {
    const inode = fs.posix.create(fs.root, marker, {
      type: "file",
      exclusive: true,
      metadata: policy,
    });
    retained.push(inode);
    const before = fs.stat(inode);
    fs.posix.chmod(inode, 0o6754);
    same(fs.posix.get(inode), { ...policy, mode: 0o6754 });
    fs.posix.chown(inode, persisted);
    same(fs.posix.get(inode), { ...persisted, mode: 0o754 });
    assert(
      fs.stat(inode).atimeNs === before.atimeNs && fs.stat(inode).mtimeNs === before.mtimeNs,
      "chmod/chown changed access or modification time",
    );
    fs.link(inode, fs.root, "posix-alias");
    fs.posix.chmod(fs.lookup(fs.root, "posix-alias"), persisted.mode);
    same(fs.posix.get(inode), persisted);
    fs.unlink(fs.root, "posix-alias", { directory: false });

    const legacy = fs.create(fs.root, "posix-legacy", { type: "file", exclusive: true });
    retained.push(legacy);
    errno(() => fs.posix.get(legacy), "ENOTSUP");
    errno(() => fs.posix.chmod(legacy, 0o600), "ENOTSUP");
    fs.posix.initialize(legacy, policy);
    fs.unlink(fs.root, "posix-legacy", { directory: false });
    same(fs.posix.get(legacy), policy);
    fs.release(legacy);
    retained.splice(retained.indexOf(legacy), 1);
    errno(() => fs.posix.get(legacy), "ENOENT");

    const symlink = fs.posix.create(fs.root, "posix-link", {
      type: "symlink",
      exclusive: true,
      target: marker,
      metadata: { ...policy, mode: 0o777 },
    });
    retained.push(symlink);
    fs.posix.chown(symlink, { uid: 3, gid: 4 });
    same(fs.posix.get(inode), persisted);
    same(fs.posix.get(symlink), { mode: 0o777, uid: 3, gid: 4 });
    errno(() => fs.posix.chown(inode, { uid: 0xffff_ffff, gid: 0 }), "EINVAL");
    errno(() => fs.posix.chmod(inode, 0o10000), "EINVAL");
    same(fs.posix.get(inode), persisted);
    return {
      name: "POSIX inode metadata, explicit legacy initialization, hardlinks and retained unlink",
      ok: true as const,
    };
  } finally {
    for (const inode of retained) fs.release(inode);
  }
}

export function readPosixStorageProof(fs: PosixStorage) {
  const inode = fs.lookup(fs.root, marker);
  same(fs.posix.get(inode), persisted);
  same(fs.posix.get(fs.root), { ...policy, mode: 0o755 });
  assert(fs.stat(inode).type === "file", "chmod changed the file type");
  return { name: "POSIX mode and unsigned owners survived a fresh request", ok: true as const };
}
