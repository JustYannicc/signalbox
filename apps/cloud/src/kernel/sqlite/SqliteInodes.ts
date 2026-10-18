import type { CreateOptions, DirectoryEntry, Inode, Stat, Times } from "../storage.ts";
import { type FacetStorage, firstRow, StorageError } from "./SqliteDatabase.ts";

const validName = (name: string) => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new StorageError("EINVAL");
  }
};

export class SqliteInodes {
  readonly root = 1n;
  readonly storage: FacetStorage;
  readonly nowNs: () => bigint;
  private readonly pins = new Map<Inode, number>();

  constructor(storage: FacetStorage, nowNs: () => bigint) {
    this.storage = storage;
    this.nowNs = nowNs;
    storage.transactionSync(() => {
      this.exec("CREATE TABLE IF NOT EXISTS kernel_fs_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      const version = this.row("SELECT v FROM kernel_fs_meta WHERE k = 'schema'");
      if (version && version.v !== "1")
        throw new Error(`Unsupported kernel filesystem schema: ${String(version.v)}`);
      this.exec(
        "CREATE TABLE IF NOT EXISTS kernel_fs_inode (ino TEXT PRIMARY KEY, type TEXT NOT NULL, size TEXT NOT NULL, nlink INTEGER NOT NULL, atime_ns TEXT NOT NULL, mtime_ns TEXT NOT NULL, ctime_ns TEXT NOT NULL, target TEXT)",
      );
      this.exec(
        "CREATE INDEX IF NOT EXISTS kernel_fs_inode_unlinked ON kernel_fs_inode (ino) WHERE nlink = 0",
      );
      this.exec(
        "CREATE TABLE IF NOT EXISTS kernel_fs_entry (parent TEXT NOT NULL, name TEXT NOT NULL, ino TEXT NOT NULL, PRIMARY KEY (parent, name))",
      );
      this.exec("CREATE INDEX IF NOT EXISTS kernel_fs_entry_ino ON kernel_fs_entry (ino)");
      this.exec(
        "CREATE TABLE IF NOT EXISTS kernel_fs_chunk (ino TEXT NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, PRIMARY KEY (ino, part))",
      );
      if (!version) {
        this.exec("INSERT INTO kernel_fs_meta (k, v) VALUES ('schema', '1'), ('next_inode', '2')");
        const now = nowNs().toString();
        this.exec(
          "INSERT INTO kernel_fs_inode VALUES ('1', 'directory', '0', 2, ?, ?, ?, NULL)",
          now,
          now,
          now,
        );
      }
      if (
        !this.row("SELECT v FROM kernel_fs_meta WHERE k = 'next_inode'") ||
        this.stat(this.root).type !== "directory"
      ) {
        throw new StorageError("EIO");
      }
      // Pins belong to one incarnation. No previous open handle survives startup.
      // Chunks without an inode indicate corruption, not lost handles; leave them intact.
      this.exec(
        "DELETE FROM kernel_fs_chunk WHERE ino IN (SELECT ino FROM kernel_fs_inode WHERE nlink = 0)",
      );
      this.exec("DELETE FROM kernel_fs_inode WHERE nlink = 0");
    });
  }

  lookup(parent: Inode, name: string): Inode {
    validName(name);
    this.directory(parent);
    const inode = this.entry(parent, name);
    if (inode === undefined) throw new StorageError("ENOENT");
    return inode;
  }

  stat(inode: Inode): Stat {
    const row = this.inode(inode);
    const type = row.type;
    const nlink = Number(row.nlink);
    if (
      (type !== "file" && type !== "directory" && type !== "symlink") ||
      !Number.isSafeInteger(nlink) ||
      nlink < 0
    ) {
      throw new StorageError("EIO");
    }
    return {
      type,
      size: BigInt(String(row.size)),
      nlink: BigInt(nlink),
      atimeNs: BigInt(String(row.atime_ns)),
      mtimeNs: BigInt(String(row.mtime_ns)),
      ctimeNs: BigInt(String(row.ctime_ns)),
    };
  }

  readlink(inode: Inode): string {
    const row = this.inode(inode);
    if (row.type !== "symlink") throw new StorageError("EINVAL");
    return String(row.target);
  }

  readdir(inode: Inode): DirectoryEntry[] {
    this.directory(inode);
    return Array.from(
      this.exec(
        "SELECT e.name, e.ino, i.type FROM kernel_fs_entry e JOIN kernel_fs_inode i ON i.ino = e.ino WHERE e.parent = ? ORDER BY e.name",
        inode.toString(),
      ),
      (row) => {
        const type = row.type;
        if (type !== "file" && type !== "directory" && type !== "symlink")
          throw new StorageError("EIO");
        return { name: String(row.name), inode: BigInt(String(row.ino)), type };
      },
    );
  }

  retain(inode: Inode): void {
    const count = this.storage.transactionSync(() => {
      if (!this.row("SELECT ino FROM kernel_fs_inode WHERE ino = ?", inode.toString()))
        throw new StorageError("ENOENT");
      return this.nextPin(inode);
    });
    this.pins.set(inode, count);
  }

  release(inode: Inode): void {
    const count = this.pins.get(inode) ?? 0;
    this.storage.transactionSync(() => {
      const row = this.row("SELECT nlink FROM kernel_fs_inode WHERE ino = ?", inode.toString());
      if (!row || count === 0) throw new StorageError("EINVAL");
      if (count === 1 && Number(row.nlink) === 0) this.destroy(inode);
    });
    if (count === 1) this.pins.delete(inode);
    else this.pins.set(inode, count - 1);
  }

  create(parent: Inode, name: string, options: CreateOptions): Inode {
    const result = this.storage.transactionSync(() => {
      validName(name);
      this.directory(parent, true);
      if (!["file", "directory", "symlink"].includes(options.type))
        throw new StorageError("EINVAL");
      if ((options.type === "symlink") !== (options.target !== undefined))
        throw new StorageError("EINVAL");
      if (
        options.target !== undefined &&
        (typeof options.target !== "string" || options.target.includes("\0"))
      )
        throw new StorageError("EINVAL");
      const existing = this.entry(parent, name);
      if (existing !== undefined) {
        if (options.exclusive) throw new StorageError("EEXIST");
        const type = this.stat(existing).type;
        if (type === "directory") throw new StorageError("EISDIR");
        if (type === "symlink") throw new StorageError("ELOOP");
        if (options.type !== "file") throw new StorageError("EEXIST");
        return { inode: existing, pins: this.nextPin(existing) };
      }
      const counter = this.row("SELECT v FROM kernel_fs_meta WHERE k = 'next_inode'");
      if (!counter || !/^[1-9][0-9]*$/.test(String(counter.v))) throw new StorageError("EIO");
      const inode = BigInt(String(counter.v));
      if (inode < 2n) throw new StorageError("EIO");
      const now = this.nowNs().toString();
      const size =
        options.type === "symlink"
          ? BigInt(new TextEncoder().encode(options.target).byteLength)
          : 0n;
      this.exec("UPDATE kernel_fs_meta SET v = ? WHERE k = 'next_inode'", (inode + 1n).toString());
      this.exec(
        "INSERT INTO kernel_fs_inode VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        inode.toString(),
        options.type,
        size.toString(),
        options.type === "directory" ? 2 : 1,
        now,
        now,
        now,
        options.target ?? null,
      );
      this.exec(
        "INSERT INTO kernel_fs_entry VALUES (?, ?, ?)",
        parent.toString(),
        name,
        inode.toString(),
      );
      this.parentChanged(parent, options.type === "directory" ? 1 : 0, now);
      return { inode, pins: 1 };
    });
    this.pins.set(result.inode, result.pins);
    return result.inode;
  }

  link(inode: Inode, parent: Inode, name: string): void {
    this.storage.transactionSync(() => {
      validName(name);
      this.directory(parent, true);
      const stat = this.stat(inode);
      if (stat.nlink === 0n) throw new StorageError("ENOENT");
      if (stat.type === "directory") throw new StorageError("EPERM");
      if (this.entry(parent, name) !== undefined) throw new StorageError("EEXIST");
      const nlink = this.linkCount(stat.nlink + 1n);
      const now = this.nowNs().toString();
      this.exec(
        "INSERT INTO kernel_fs_entry VALUES (?, ?, ?)",
        parent.toString(),
        name,
        inode.toString(),
      );
      this.exec(
        "UPDATE kernel_fs_inode SET nlink = ?, ctime_ns = ? WHERE ino = ?",
        nlink,
        now,
        inode.toString(),
      );
      this.parentChanged(parent, 0, now);
    });
  }

  unlink(parent: Inode, name: string, options: { directory: boolean }): void {
    this.storage.transactionSync(() => {
      validName(name);
      this.directory(parent, true);
      const inode = this.lookup(parent, name);
      const stat = this.removable(inode, options.directory);
      this.detach(parent, name, inode, stat, this.nowNs().toString());
    });
  }

  rename(fromParent: Inode, fromName: string, toParent: Inode, toName: string): void {
    this.storage.transactionSync(() => {
      validName(fromName);
      validName(toName);
      this.directory(fromParent, true);
      this.directory(toParent, true);
      const inode = this.lookup(fromParent, fromName);
      if (inode === this.root) throw new StorageError("EBUSY");
      const stat = this.stat(inode);
      const destination = this.entry(toParent, toName);
      if (destination === inode) return;
      const replaced =
        destination === undefined
          ? undefined
          : this.removable(destination, stat.type === "directory");
      if (stat.type === "directory") this.noCycle(inode, toParent);
      const now = this.nowNs().toString();
      if (destination !== undefined && replaced)
        this.detach(toParent, toName, destination, replaced, now);
      this.exec(
        "DELETE FROM kernel_fs_entry WHERE parent = ? AND name = ?",
        fromParent.toString(),
        fromName,
      );
      this.exec(
        "INSERT INTO kernel_fs_entry VALUES (?, ?, ?)",
        toParent.toString(),
        toName,
        inode.toString(),
      );
      this.exec("UPDATE kernel_fs_inode SET ctime_ns = ? WHERE ino = ?", now, inode.toString());
      const movingDirectory = stat.type === "directory" && fromParent !== toParent;
      this.parentChanged(fromParent, movingDirectory ? -1 : 0, now);
      if (fromParent !== toParent) this.parentChanged(toParent, movingDirectory ? 1 : 0, now);
    });
  }

  setTimes(inode: Inode, times: Times): void {
    this.storage.transactionSync(() => {
      const stat = this.stat(inode);
      this.exec(
        "UPDATE kernel_fs_inode SET atime_ns = ?, mtime_ns = ?, ctime_ns = ? WHERE ino = ?",
        (times.atimeNs ?? stat.atimeNs).toString(),
        (times.mtimeNs ?? stat.mtimeNs).toString(),
        this.nowNs().toString(),
        inode.toString(),
      );
    });
  }

  private exec(query: string, ...bindings: (string | number | null)[]) {
    return this.storage.sql.exec(query, ...bindings);
  }

  private row(
    query: string,
    ...bindings: (string | number)[]
  ): Record<string, unknown> | undefined {
    return firstRow(this.exec(query, ...bindings));
  }

  private inode(inode: Inode) {
    const row = this.row("SELECT * FROM kernel_fs_inode WHERE ino = ?", inode.toString());
    if (!row) throw new StorageError("ENOENT");
    return row;
  }

  private directory(inode: Inode, linked = false): void {
    const stat = this.stat(inode);
    if (stat.type !== "directory") throw new StorageError("ENOTDIR");
    if (linked && stat.nlink === 0n) throw new StorageError("ENOENT");
  }

  private entry(parent: Inode, name: string) {
    const row = this.row(
      "SELECT ino FROM kernel_fs_entry WHERE parent = ? AND name = ?",
      parent.toString(),
      name,
    );
    return row ? BigInt(String(row.ino)) : undefined;
  }

  private nextPin(inode: Inode) {
    const count = (this.pins.get(inode) ?? 0) + 1;
    if (!Number.isSafeInteger(count)) throw new StorageError("EOVERFLOW");
    return count;
  }

  private linkCount(count: bigint) {
    if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new StorageError("EMLINK");
    return Number(count);
  }

  private parentChanged(parent: Inode, delta: number, now: string): void {
    const nlink = this.linkCount(this.stat(parent).nlink + BigInt(delta));
    this.exec(
      "UPDATE kernel_fs_inode SET nlink = ?, mtime_ns = ?, ctime_ns = ? WHERE ino = ?",
      nlink,
      now,
      now,
      parent.toString(),
    );
  }

  private removable(inode: Inode, directory: boolean) {
    if (inode === this.root) throw new StorageError("EBUSY");
    const stat = this.stat(inode);
    if (stat.type === "directory" && !directory) throw new StorageError("EISDIR");
    if (stat.type !== "directory" && directory) throw new StorageError("ENOTDIR");
    if (
      directory &&
      this.row("SELECT ino FROM kernel_fs_entry WHERE parent = ? LIMIT 1", inode.toString())
    )
      throw new StorageError("ENOTEMPTY");
    return stat;
  }

  private detach(parent: Inode, name: string, inode: Inode, stat: Stat, now: string): void {
    const nlink = stat.type === "directory" ? 0 : this.linkCount(stat.nlink - 1n);
    this.exec("DELETE FROM kernel_fs_entry WHERE parent = ? AND name = ?", parent.toString(), name);
    this.exec(
      "UPDATE kernel_fs_inode SET nlink = ?, ctime_ns = ? WHERE ino = ?",
      nlink,
      now,
      inode.toString(),
    );
    this.parentChanged(parent, stat.type === "directory" ? -1 : 0, now);
    if (nlink === 0 && !this.pins.has(inode)) this.destroy(inode);
  }

  private destroy(inode: Inode): void {
    this.exec("DELETE FROM kernel_fs_chunk WHERE ino = ?", inode.toString());
    this.exec("DELETE FROM kernel_fs_inode WHERE ino = ?", inode.toString());
  }

  private noCycle(inode: Inode, parent: Inode): void {
    const visited = new Set<Inode>();
    while (true) {
      if (parent === inode) throw new StorageError("EINVAL");
      if (parent === this.root) return;
      if (visited.has(parent)) throw new StorageError("EIO");
      visited.add(parent);
      const entry = this.row("SELECT parent FROM kernel_fs_entry WHERE ino = ?", parent.toString());
      if (!entry) throw new StorageError("EIO");
      parent = BigInt(String(entry.parent));
    }
  }
}
