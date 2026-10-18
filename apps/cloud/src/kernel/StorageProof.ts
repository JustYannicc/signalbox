import type { Storage } from "./storage.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function errno(action: () => unknown, code: string) {
  try {
    action();
  } catch (error) {
    assert(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}, got ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
const readText = (fs: Storage, inode: bigint) => {
  const buffer = new Uint8Array(32);
  return decoder.decode(buffer.subarray(0, fs.readInto(inode, 0n, buffer)));
};

/** Behavior cases shared by Node tests and the #1057 local/deployed fixture. */
export function runStorageProof(fs: Storage) {
  const checks: { name: string; ok: boolean; error?: string }[] = [];
  const check = (name: string, run: () => void) => {
    try {
      run();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, error: String(error) });
    }
  };
  const dir = fs.create(fs.root, "proof", { type: "directory", exclusive: true });
  const file = (name: string) => fs.create(dir, name, { type: "file", exclusive: true });

  check("chunk boundaries, holes and bigint offsets", () => {
    const inode = file("chunks");
    fs.write(inode, 65_534n, new Uint8Array([1, 2, 3, 4]));
    const buffer = new Uint8Array(8).fill(255);
    assert(fs.readInto(inode, 65_532n, buffer) === 6, "Wrong partial read length");
    assert(buffer.join() === "0,0,1,2,3,4,255,255", "Chunk boundary or EOF corrupted bytes");
    const offset = (1n << 54n) + 9n;
    fs.write(inode, offset, new Uint8Array([7]));
    assert(fs.stat(inode).size === offset + 1n, "Bigint size lost precision");
    const far = new Uint8Array(3).fill(255);
    assert(
      fs.readInto(inode, offset - 2n, far) === 3 && far.join() === "0,0,7",
      "Sparse bigint read failed",
    );
    assert(fs.readInto(inode, offset + 1n, far) === 0, "EOF read was not zero");
    fs.write(inode, offset + 100n, new Uint8Array());
    assert(fs.stat(inode).size === offset + 1n, "Empty write extended a file");
    errno(() => fs.write(inode, -1n, new Uint8Array([1])), "EINVAL");
    errno(() => fs.write(inode, (1n << 63n) - 1n, new Uint8Array([1])), "EFBIG");
    fs.release(inode);
  });

  check("truncate regrowth never exposes discarded bytes", () => {
    const inode = file("truncate");
    fs.write(inode, 65_534n, new Uint8Array([1, 2, 3, 4]));
    fs.truncate(inode, 65_535n);
    fs.truncate(inode, 65_538n);
    const buffer = new Uint8Array(4);
    assert(
      fs.readInto(inode, 65_534n, buffer) === 4 && buffer.join() === "1,0,0,0",
      "Truncated bytes resurfaced",
    );
    fs.truncate(inode, 0n);
    const appended = fs.append(inode, encoder.encode("one"));
    const second = fs.append(inode, encoder.encode("two"));
    assert(
      appended.offset === 0n && second.offset === 3n && readText(fs, inode) === "onetwo",
      "Append offset was wrong",
    );
    fs.release(inode);
  });

  check("retained unlink and hardlinks preserve inode identity", () => {
    const inode = file("original");
    fs.write(inode, 0n, encoder.encode("live"));
    fs.link(inode, dir, "alias");
    assert(
      fs.stat(inode).nlink === 2n && fs.lookup(dir, "alias") === inode,
      "Hardlink copied rather than linked",
    );
    fs.unlink(dir, "original", { directory: false });
    fs.unlink(dir, "alias", { directory: false });
    assert(
      fs.stat(inode).nlink === 0n && readText(fs, inode) === "live",
      "Unlink destroyed retained bytes",
    );
    fs.release(inode);
    errno(() => fs.stat(inode), "ENOENT");
    const replacement = file("replacement");
    assert(replacement !== inode, "Inode identity was reused");
    fs.release(replacement);
  });

  check("atomic create and rename preserve retained replacement", () => {
    const first = file("rename-from");
    const old = file("rename-to");
    fs.write(first, 0n, encoder.encode("new"));
    fs.write(old, 0n, encoder.encode("old"));
    const reopened = fs.create(dir, "rename-from", { type: "file", exclusive: false });
    assert(
      reopened === first && readText(fs, reopened) === "new",
      "Nonexclusive create truncated or replaced inode",
    );
    fs.release(reopened);
    fs.rename(dir, "rename-from", dir, "rename-to");
    assert(
      fs.lookup(dir, "rename-to") === first && readText(fs, old) === "old",
      "Rename corrupted retained destination",
    );
    errno(() => fs.lookup(dir, "rename-from"), "ENOENT");
    fs.release(old);
    errno(() => fs.stat(old), "ENOENT");
    fs.release(first);
  });

  check("directory cycles, nonempty replacement and invalid components fail atomically", () => {
    const parent = fs.create(dir, "parent", { type: "directory", exclusive: true });
    const child = fs.create(parent, "child", { type: "directory", exclusive: true });
    assert(fs.stat(parent).nlink === 3n, "Directory links did not count child");
    errno(() => fs.rename(dir, "parent", child, "loop"), "EINVAL");
    assert(
      fs.lookup(dir, "parent") === parent && fs.lookup(parent, "child") === child,
      "Failed cycle rename changed tree",
    );
    errno(() => fs.unlink(dir, "parent", { directory: true }), "ENOTEMPTY");
    errno(() => fs.link(parent, dir, "dirlink"), "EPERM");
    for (const name of ["", ".", "..", "a/b", "a\0b"]) errno(() => file(name), "EINVAL");
    fs.unlink(parent, "child", { directory: true });
    assert(
      fs.stat(child).nlink === 0n && fs.stat(parent).nlink === 2n,
      "Removed directory link counts were wrong",
    );
    fs.release(child);
    fs.release(parent);
  });

  check("symlink contents and nanosecond metadata roundtrip exactly", () => {
    const link = fs.create(dir, "symlink", {
      type: "symlink",
      exclusive: true,
      target: "../target",
    });
    assert(
      fs.readlink(link) === "../target" && fs.stat(link).type === "symlink",
      "Backend followed symlink",
    );
    errno(() => fs.create(dir, "symlink", { type: "file", exclusive: false }), "ELOOP");
    errno(() => fs.create(dir, "parent", { type: "file", exclusive: false }), "EISDIR");
    const time = 9_007_199_254_740_993_123n;
    fs.setTimes(link, { atimeNs: time, mtimeNs: time + 1n });
    assert(
      fs.stat(link).atimeNs === time && fs.stat(link).mtimeNs === time + 1n,
      "Timestamp lost bigint precision",
    );
    fs.sync(link, false);
    fs.release(link);
  });

  const persistent = file("persistent");
  fs.write(persistent, 0n, encoder.encode("facet-owned"));
  fs.release(persistent);
  fs.release(dir);
  return { ok: checks.every((result) => result.ok), checks };
}

export function readStoragePersistence(fs: Storage) {
  const dir = fs.lookup(fs.root, "proof");
  const inode = fs.lookup(dir, "persistent");
  assert(
    readText(fs, inode) === "facet-owned",
    "Facet SQLite data did not survive another request",
  );
  return { ok: true, checks: [{ name: "second-request SQLite persistence", ok: true }] };
}
