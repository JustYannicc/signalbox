import { KernelOpenFlags, parseOpenFlags } from "../../kernel/KernelOpenFlags.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import type { KernelStat } from "../../kernel/KernelFileSystem.ts";
import type { createNodeFsSyscallClient } from "../../isolate/NodeFsSyscallClient.ts";
import type { CliFileWorkingSet } from "./WorkingSet.ts";
import type { CliFilePaths } from "./Paths.ts";
import type { CliContentView } from "./Content.ts";

interface ReadView {
  path: string;
  readonly flags: number;
  readonly writable: boolean;
  readonly readable: boolean;
  offset: bigint;
  release: () => void;
  stat: KernelStat;
  content?: CliContentView | undefined;
}

/** IDs are issued by Computer. These read views never allocate or authorize a descriptor. */
export class CliDescriptorViews {
  readonly #leased: number[] = [];
  readonly #views = new Map<number, ReadView>();
  readonly #slots = new Set<number>();
  readonly #files;
  readonly #paths;
  readonly #remote;
  readonly #reserve;
  constructor(
    files: CliFileWorkingSet,
    paths: CliFilePaths,
    remote: ReturnType<typeof createNodeFsSyscallClient>,
    reserve: (fd: number) => Promise<void>,
  ) {
    this.#files = files;
    this.#paths = paths;
    this.#remote = remote;
    this.#reserve = reserve;
  }
  lease(ids: readonly number[]) {
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 3 || this.#leased.includes(id) || this.#views.has(id))
        throw new Error("Computer issued an invalid or duplicate descriptor lease");
      this.#slots.add(id);
      this.#leased.push(id);
    }
  }
  get missingLeases() {
    return Math.max(0, 32 - this.#leased.length);
  }
  observeOpen(fd: number, path: string, flags: number, stat: KernelStat) {
    const parsed = parseOpenFlags(flags);
    let canonical = path;
    let content: CliContentView | undefined;
    try {
      canonical = this.#paths.resolve(path);
      const metadata = this.#files.metadata(canonical).stat;
      if (
        metadata.ino === stat.ino &&
        metadata.dev === stat.dev &&
        this.#files.hasContent(canonical)
      )
        content = this.#files.view(canonical);
    } catch (cause) {
      if (
        !(
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          ["ENOENT", "ESTALE", "CLI_FS_NOT_PREFETCHED"].includes(String(cause.code))
        )
      )
        throw cause;
    }
    this.#views.set(fd, {
      path: canonical,
      flags,
      readable: !parsed.pathOnly && parsed.accessMode !== 1,
      writable: !parsed.pathOnly && parsed.accessMode !== 0,
      offset: 0n,
      stat,
      ...(content === undefined ? {} : { content }),
      release: content?.release ?? (() => {}),
    });
  }
  observeClose(fd: number) {
    this.#views.get(fd)?.release();
    this.#views.delete(fd);
  }
  observeOffset(fd: number, offset: bigint) {
    const view = this.#views.get(fd);
    if (view !== undefined) view.offset = offset;
  }
  isPublic(fd: number) {
    return this.#views.has(fd);
  }
  get(fd: number) {
    this.#files.assertCurrent();
    const view = this.#views.get(fd);
    if (view === undefined) throw kernelError("EBADF");
    return view;
  }
  open(path: string, flags: number, mode?: number) {
    this.#files.assertCurrent();
    const parsed = parseOpenFlags(flags);
    let canonical: string;
    let created = false;
    try {
      canonical = this.#paths.resolve(path, !parsed.noFollow);
    } catch (cause) {
      if (
        !parsed.create ||
        !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
      canonical = this.#paths.destination(path);
      created = true;
    }
    const ancestor = created
      ? this.#files.metadata(
          this.#paths.resolve(canonical.slice(0, canonical.lastIndexOf("/")) || "/"),
        )
      : undefined;
    const policy = this.#paths.policy;
    if (ancestor !== undefined) this.#paths.assertAccess(ancestor.stat, 3);
    const stat: KernelStat = created
      ? {
          ...ancestor!.stat,
          type: "file",
          ino: 0n,
          nlink: 1n,
          size: 0n,
          ...(policy === undefined
            ? {}
            : {
                posix: {
                  uid: policy.credentials.euid,
                  gid: policy.credentials.egid,
                  mode: (mode ?? 0o666) & ~policy.umask,
                },
              }),
        }
      : this.#files.metadata(canonical).stat;
    if (parsed.directory && stat.type !== "directory") throw kernelError("ENOTDIR");
    if (parsed.noFollow && stat.type === "symlink" && !parsed.pathOnly) throw kernelError("ELOOP");
    if (!created && parsed.create && parsed.exclusive) throw kernelError("EEXIST");
    const readable = !parsed.pathOnly && parsed.accessMode !== 1;
    const writable = !parsed.pathOnly && parsed.accessMode !== 0;
    if (writable && stat.type === "directory") throw kernelError("EISDIR");
    if (!created && !parsed.pathOnly)
      this.#paths.assertAccess(stat, (readable ? 4 : 0) | (writable || parsed.truncate ? 2 : 0));
    const fd = this.#leased[0];
    if (fd === undefined)
      throw Object.assign(new Error("Synchronous descriptor leases need asynchronous refill"), {
        code: "CLI_FS_NOT_PREFETCHED",
      });
    if (created) {
      this.#files.updateMetadata({ path: canonical, pending: true, stat });
      this.#files.replaceContent(canonical, new Uint8Array(0));
    }
    if (parsed.truncate && !this.#files.hasContent(canonical))
      this.#files.replaceContent(canonical, new Uint8Array(0));
    const content =
      stat.type === "file" && (readable || this.#files.hasContent(canonical))
        ? this.#files.view(canonical)
        : undefined;
    const release = content?.release ?? (() => {});
    try {
      this.#files.writes.enqueue(0, async () => {
        const opened = await this.#remote.call("open", [canonical, flags, mode]);
        try {
          await this.#remote.move(opened, fd);
        } catch (cause) {
          await this.#remote.close(opened);
          throw cause;
        }
      });
      this.#leased.shift();
      this.#views.set(fd, {
        path: canonical,
        flags,
        readable,
        writable,
        offset: 0n,
        stat,
        ...(content === undefined ? {} : { content }),
        release,
      });
      if (parsed.truncate) this.truncate(fd, 0n);
      return fd;
    } catch (cause) {
      release();
      throw cause;
    }
  }
  close(fd: number) {
    const view = this.get(fd);
    this.#views.delete(fd);
    view.release();
    this.#files.writes.enqueue(
      0,
      async () => {
        if (!this.#slots.has(fd)) {
          await this.#remote.close(fd);
          return;
        }
        const placeholder = await this.#remote.open(
          "/",
          KernelOpenFlags.O_PATH | KernelOpenFlags.O_DIRECTORY,
        );
        try {
          await this.#remote.move(placeholder, fd);
          await this.#reserve(fd);
        } catch (cause) {
          await this.#remote.close(placeholder);
          throw cause;
        }
      },
      true,
    );
    if (this.#slots.has(fd)) this.#leased.push(fd);
  }
  stat(fd: number): KernelStat {
    const view = this.get(fd);
    const metadata = this.#files.entries.find((item) =>
      item.pending
        ? item.path === view.path
        : view.stat.ino !== 0n &&
          item.stat.ino === view.stat.ino &&
          item.stat.dev === view.stat.dev,
    );
    return (
      metadata?.stat ?? {
        ...view.stat,
        ...(view.content === undefined ? {} : { size: BigInt(view.content.size) }),
      }
    );
  }
  unlink(path: string) {
    const entry = this.#files.metadata(path);
    for (const view of this.#views.values())
      if (
        view.path === path ||
        (!entry.pending && view.stat.ino === entry.stat.ino && view.stat.dev === entry.stat.dev)
      )
        view.stat = { ...view.stat, nlink: view.stat.nlink > 0n ? view.stat.nlink - 1n : 0n };
  }
  rename(from: string, to: string) {
    for (const view of this.#views.values()) {
      if (view.path === from || view.path.startsWith(`${from}/`))
        view.path = to + view.path.slice(from.length);
    }
  }
  read(fd: number, target: Uint8Array, position: bigint | null) {
    const view = this.get(fd);
    if (!view.readable) throw kernelError("EBADF");
    if (view.content === undefined)
      throw Object.assign(new Error("Descriptor content was not prefetched"), {
        code: "CLI_FS_NOT_PREFETCHED",
      });
    const offset = position ?? view.offset;
    if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) throw kernelError("EINVAL");
    const count = view.content.copyInto(target, Number(offset));
    if (position === null) {
      const next = offset + BigInt(count);
      this.#files.writes.enqueue(0, async () => {
        await this.#remote.seek(fd, next);
      });
      view.offset = next;
    }
    return count;
  }
  write(fd: number, source: Uint8Array, position: bigint | null) {
    const view = this.get(fd);
    if (!view.writable) throw kernelError("EBADF");
    const previous = this.stat(fd).size;
    const append = (view.flags & KernelOpenFlags.O_APPEND) !== 0;
    const offset = append ? previous : (position ?? view.offset);
    if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER - source.byteLength))
      throw kernelError("EFBIG");
    const size = Math.max(Number(previous), Number(offset) + source.byteLength);
    let bytes: Uint8Array;
    this.#files.writes.enqueue(
      source.byteLength,
      async () => {
        let written = 0;
        while (written < bytes.byteLength) {
          const count = await this.#remote.write(
            fd,
            bytes.subarray(written),
            position === null ? null : position + BigInt(written),
          );
          if (count === 0) throw kernelError("EIO");
          written += count;
        }
      },
      false,
      () => {
        bytes = source.slice();
        view.content?.replace(size, (next) => {
          view.content!.copyInto(next, 0);
          next.set(bytes, Number(offset));
        });
      },
    );
    this.#projectSize(view, BigInt(size));
    if (position === null) view.offset = offset + BigInt(source.byteLength);
    return source.byteLength;
  }
  truncate(fd: number, size: bigint) {
    const view = this.get(fd);
    if (!view.writable) throw kernelError("EBADF");
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw kernelError("EINVAL");
    this.#files.writes.enqueue(
      0,
      async () => {
        await this.#remote.ftruncate(fd, size);
      },
      false,
      () => {
        view.content?.replace(Number(size), (next) => {
          if (next.byteLength > 0) view.content!.copyInto(next, 0);
        });
      },
    );
    this.#projectSize(view, size);
  }
  #projectSize(view: ReadView, size: bigint) {
    for (const current of this.#views.values())
      if (
        current === view ||
        (view.stat.ino !== 0n &&
          current.stat.ino === view.stat.ino &&
          current.stat.dev === view.stat.dev)
      )
        current.stat = { ...current.stat, size };
    for (const entry of this.#files.entries)
      if (
        entry.pending
          ? entry.path === view.path
          : view.stat.ino !== 0n &&
            entry.stat.ino === view.stat.ino &&
            entry.stat.dev === view.stat.dev
      )
        this.#files.updateMetadata({ ...entry, stat: { ...entry.stat, size } });
  }
  releaseNamedContent() {
    for (const view of this.#views.values()) {
      const named = this.#files.entries.some(
        (entry) =>
          !entry.pending && entry.stat.ino === view.stat.ino && entry.stat.dev === view.stat.dev,
      );
      if (!named) continue;
      view.release();
      view.release = () => {};
      view.content = undefined;
    }
  }
  async refresh() {
    for (const [fd, view] of this.#views) {
      const previous = view.stat;
      view.stat = await this.#remote.fstat(fd);
      const entry = this.#files.entries.find(
        (item) =>
          !item.pending && item.stat.ino === view.stat.ino && item.stat.dev === view.stat.dev,
      );
      if (entry !== undefined) {
        view.path = entry.path;
        view.release();
        view.release = () => {};
        view.content = undefined;
        if (this.#files.hasContent(entry.path)) {
          view.content = this.#files.view(entry.path);
          view.release = view.content.release;
        }
      } else if (
        view.content !== undefined &&
        (previous.size !== view.stat.size ||
          previous.mtimeNs !== view.stat.mtimeNs ||
          previous.ctimeNs !== view.stat.ctimeNs)
      ) {
        const content = view.content;
        const size = Number(view.stat.size);
        if (!Number.isSafeInteger(size)) throw kernelError("EFBIG");
        await content.refill(size, async (bytes) => {
          let offset = 0;
          while (offset < size) {
            const count = await this.#remote.read(
              fd,
              bytes.subarray(offset, Math.min(size, offset + 1024 * 1024)),
              BigInt(offset),
            );
            if (count === 0) throw kernelError("EIO");
            offset += count;
          }
        });
      }
    }
  }
  async closeAll() {
    for (const view of this.#views.values()) view.release();
    const ids = [...this.#views.keys(), ...this.#leased];
    this.#views.clear();
    this.#leased.length = 0;
    this.#slots.clear();
    for (const fd of ids) {
      try {
        await this.#remote.close(fd);
      } catch (cause) {
        if (
          !(
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "EBADF"
          )
        )
          throw cause;
      }
    }
  }
}
