import type {
  NodeFsBackend,
  NodeFsOperation,
  NodeFsArguments,
  NodeFsResult,
} from "../../isolate/NodeFsBackend.ts";
import { createNodeFsSyscallClient } from "../../isolate/NodeFsSyscallClient.ts";
import { KernelOpenFlags } from "../../kernel/KernelOpenFlags.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import type { ClaudeCliInitialization } from "../ClaudeCliKernelPort.ts";
import type { KernelStat } from "../../kernel/KernelFileSystem.ts";
import { CliFileWorkingSet, withStat } from "./WorkingSet.ts";
import { CliFilePaths } from "./Paths.ts";
import { CliDescriptorViews } from "./Descriptors.ts";
import { createCliMetadataMutations } from "./Mutations.ts";
import { createCliFileSync } from "./Sync.ts";
import { watchEventLoop } from "./LoopMonitor.ts";
import { CliViewMiss } from "./Content.ts";
import { createCliPrefetch } from "./Prefetch.ts";
import { CliDescriptorHolds } from "./DescriptorHolds.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";

/** Like an NFS attribute cache or FUSE's default attr_timeout: Computer's own changes show this soon. */
const METADATA_FRESH_MS = 1_000;

const viewedMetadata = new Set<NodeFsOperation>([
  "access",
  "lstat",
  "readdir",
  "readlink",
  "realpath",
  "stat",
]);

const mutating = new Set<NodeFsOperation>([
  "chmod",
  "fchmod",
  "chown",
  "fchown",
  "fsetTimes",
  "ftruncate",
  "link",
  "mkdir",
  "rename",
  "rmdir",
  "setTimes",
  "symlink",
  "truncate",
  "unlink",
  "write",
]);

export async function createCliFileBackend(
  input: Pick<
    ClaudeCliInitialization,
    "kernel" | "cwd" | "rootDescriptor" | "posix" | "workingSet" | "process"
  > & {
    readonly trace?: (event: CliViewTrace) => void;
    /** Files to hold besides the ones the CLI itself reads synchronously. */
    readonly syncReads?: readonly string[];
  },
  signal: AbortSignal,
) {
  const kernel = input.kernel;
  // Diagnostics never fail the view. Computer's own log keeps every trace, turn or not; the
  // caller's sink (the host's turn log) gets it too.
  const trace = (event: CliViewTrace) => {
    try {
      input.trace?.(event);
    } catch {
      /* A lost trace is only a missing diagnostic. */
    }
    try {
      void kernel.trace(event).catch(() => undefined);
    } catch {
      /* As above. */
    }
  };
  const files = new CliFileWorkingSet(input.workingSet);
  const remote = createNodeFsSyscallClient({
    syscalls: kernel,
    rootDescriptor: input.rootDescriptor,
    posix: input.posix !== undefined,
    signal,
  });
  let policy = input.posix;
  const paths = new CliFilePaths(files, input.cwd, () => policy);
  const holds = new CliDescriptorHolds();
  const views = new CliDescriptorViews(
    files,
    paths,
    remote,
    (fd) => kernel.reserveDescriptor(fd),
    (fd) => holds.released(fd),
  );
  const disposals = new Set<() => void>();
  const operations = new Set<Promise<unknown>>();
  const home = input.process.identity.homedir;
  const prefetcher = createCliPrefetch({
    files,
    paths,
    kernel,
    roots: {
      cwd: input.cwd,
      home,
      configDir: input.process.env.CLAUDE_CONFIG_DIR ?? `${home}/.claude`,
    },
    byteLimit: input.workingSet.byteLimit,
    extra: input.syncReads ?? [],
    trace,
    signal,
  });
  let leasing: Promise<void> | undefined;
  const refillLeases = () =>
    (leasing ??= (async () => {
      if (views.missingLeases > 0) views.lease(await kernel.leaseDescriptors(views.missingLeases));
    })().finally(() => {
      leasing = undefined;
    }));
  const fileSync = createCliFileSync({
    files,
    views,
    kernel,
    metadataLimit: input.workingSet.metadataLimit,
    prefetch: prefetcher.prefetch,
    trace,
  });
  // Children and SDK file calls change Computer outside the CLI. Meanwhile the view stays the last
  // consistent picture, which is what a reader racing a writer gets on Linux, and rounds catch it up.
  let remoteMutations = 0;
  /** When a barrier last asked Computer, or a round last caught the view up. */
  let checkedAt = Number.NEGATIVE_INFINITY;
  /** The view lags Computer: a round failed, or could re-read only the CLI's own changes. */
  let behind = false;
  /** Computer's revision when a round last re-read only the CLI's own changes. */
  let ownRevision: number | undefined;
  let failures = 0;
  let retryAt = Number.NEGATIVE_INFINITY;
  let syncing: Promise<void> | undefined;
  let requestedRounds = 0;
  let completedRounds = 0;
  /**
   * Waits for a round that started after this call, so it covers everything committed before. A
   * failed round leaves the view where it was, and the next one waits out a growing backoff. It is
   * never the CLI call's error: that call read or wrote Computer, not the view.
   */
  const sync = async () => {
    const wanted = ++requestedRounds;
    while (completedRounds < wanted && performance.now() >= retryAt) {
      if (syncing === undefined) {
        const covers = requestedRounds;
        syncing = (async () => {
          const started = performance.now();
          try {
            const round = await fileSync.round(remoteMutations > 0);
            behind = !round.caughtUp;
            ownRevision = round.caughtUp ? undefined : round.revision;
            if (round.caughtUp) checkedAt = Math.max(checkedAt, started);
            failures = 0;
          } catch {
            behind = true;
            ownRevision = undefined;
            const retryMs = Math.min(30_000, 250 * 2 ** failures++);
            retryAt = performance.now() + retryMs;
            trace({ kind: "backoff", failures, retryMs });
          } finally {
            completedRounds = Math.max(completedRounds, covers);
          }
          // Missing leases only make sync opens wait; the next barrier asks again.
          await refillLeases().catch(() => undefined);
        })().finally(() => {
          syncing = undefined;
        });
      }
      await syncing;
    }
  };
  const committed = async () => {
    await files.writes.flush();
    return kernel.processState(paths.cwd, policy?.umask);
  };
  // Output needs only the CLI's own writes in Computer, never a view round.
  const commit = async () => {
    await committed();
  };
  const barrier = async () => {
    const started = performance.now();
    // A miss's fetch finishes before the CLI's next call relies on it.
    await prefetcher.settled();
    const revision = await committed();
    // Only the CLI's own changes are readable while a machine command runs, and none came since.
    const nothingNew = behind && ownRevision === revision && files.projections.size === 0;
    if ((revision !== files.revision || files.projections.size > 0) && !nothingNew) await sync();
    else await refillLeases().catch(() => undefined);
    // Writes queued while the round read Computer still commit before callers rely on them.
    await files.writes.flush();
    checkedAt = Math.max(checkedAt, started);
  };
  let confirming: Promise<void> | undefined;
  const beforeRemote = async () => {
    await barrier();
    remoteMutations++;
  };
  const afterRemote = async () => {
    remoteMutations--;
    if (remoteMutations > 0 || signal.aborted) return;
    await sync();
  };
  /** Async calls bypass projection, so their targets' cached bytes are Computer's, not the CLI's. */
  const markRemote = (values: readonly unknown[], pathIndices: readonly number[]) => {
    const targets = pathIndices.flatMap((index) => {
      const path = values[index];
      if (typeof path !== "string") return [];
      // Only canonical names: a lexical path through a symlink is not a view entry. The call
      // may have acted on the link or its target, so both are marked.
      return [
        () => paths.resolve(path, false),
        () => paths.resolve(path),
        () => paths.destination(path),
      ].flatMap((canonical) => {
        try {
          return [canonical()];
        } catch {
          return [];
        }
      });
    });
    if (pathIndices.length === 0 && typeof values[0] === "number") {
      const path = views.pathOf(values[0]);
      if (path !== undefined) targets.push(path);
    }
    for (const path of targets) files.projections.touch(path, true);
  };
  const remoteRun = <K extends NodeFsOperation>(
    name: K,
    args: NodeFsArguments<K>,
    userSignal?: AbortSignal,
  ): Promise<NodeFsResult<K>> => {
    const mutation =
      mutating.has(name) ||
      (name === "open" &&
        (Number(args[1]) & (KernelOpenFlags.O_CREAT | KernelOpenFlags.O_TRUNC)) !== 0);
    const operation = (async () => {
      if (
        [
          "close",
          "read",
          "write",
          "fstat",
          "fchmod",
          "fchown",
          "fsetTimes",
          "ftruncate",
          "sync",
        ].includes(name) &&
        !(Number(args[0]) >= 0 && (Number(args[0]) <= 2 || views.isPublic(Number(args[0]))))
      )
        throw kernelError("EBADF");
      await barrier();
      const values: unknown[] = [...args];
      const pathIndices =
        name === "symlink"
          ? [1]
          : name === "link" || name === "rename"
            ? [0, 1]
            : [
                  "open",
                  "stat",
                  "lstat",
                  "mkdir",
                  "rmdir",
                  "unlink",
                  "readlink",
                  "realpath",
                  "readdir",
                  "access",
                  "chmod",
                  "chown",
                  "setTimes",
                  "truncate",
                ].includes(name)
              ? [0]
              : [];
      for (const index of pathIndices)
        if (typeof values[index] === "string") values[index] = paths.absolute(values[index]);
      const held = name === "close" ? holds.released(Number(values[0])) : undefined;
      if (held !== undefined) {
        // A child still has it. The CLI's copy is closed now, as on Linux; Computer's goes when
        // the child no longer needs it, so the CLI never waits for a child.
        const fd = Number(values[0]);
        views.observeClose(fd);
        void held.then(() => remote.close(fd)).catch(() => undefined);
        return undefined as NodeFsResult<K>;
      }
      try {
        const result = await remote.call(name, values as NodeFsArguments<K>, userSignal);
        if (name === "open") {
          const fd = Number(result);
          try {
            const stat = await remote.fstat(fd, userSignal);
            userSignal?.throwIfAborted();
            views.observeOpen(fd, String(values[0]), Number(values[1]), stat);
          } catch (cause) {
            try {
              await remote.close(fd);
            } catch (cleanup) {
              throw new AggregateError([cause, cleanup], "CLI open and descriptor cleanup failed", {
                cause,
              });
            }
            throw cause;
          }
        } else if (name === "close") views.observeClose(Number(values[0]));
        else if ((name === "read" || name === "write") && values[2] === null)
          views.observeOffset(
            Number(values[0]),
            await remote.position(Number(values[0]), userSignal),
          );
        return result;
      } finally {
        if (mutation) {
          markRemote(values, pathIndices);
          await sync();
        }
      }
    })();
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };
  // Filled with the backend's own methods below, before they are wrapped.
  const direct = new Map<string, (...args: unknown[]) => unknown>();
  /**
   * Metadata the CLI asks for asynchronously comes from the view, which rounds keep current, as
   * for its sync calls. Asking Computer costs an RPC per call, and the CLI walks trees with tens of
   * thousands of them.
   */
  const run = <K extends NodeFsOperation>(
    name: K,
    args: NodeFsArguments<K>,
    userSignal?: AbortSignal,
  ): Promise<NodeFsResult<K>> => {
    const path = typeof args[0] === "string" ? paths.absolute(args[0]) : undefined;
    // Computer synthesizes /proc and /dev, so the view never indexed them.
    if (!viewedMetadata.has(name) || path === undefined || /^\/(?:proc|dev)(?:\/|$)/.test(path))
      return remoteRun(name, args, userSignal);
    return (async () => {
      // One barrier a second covers every call, so changes nobody bracketed still show. It
      // waits for a round only when Computer moved; otherwise the view is already current.
      if (performance.now() - checkedAt >= METADATA_FRESH_MS)
        await (confirming ??= barrier().finally(() => {
          confirming = undefined;
        }));
      userSignal?.throwIfAborted();
      // A child is writing what Computer can't list yet, so only Computer knows until it ends.
      if (!behind)
        try {
          return direct.get(name)!.apply(backend, args) as NodeFsResult<K>;
        } catch (cause) {
          // A listing the index never read is Computer's to answer, and its round may index it.
          if (!(cause instanceof CliViewMiss)) throw cause;
          return remoteRun(name, args, userSignal);
        }
      // One call: the barrier above already ran this second, and only the CLI's writes must land.
      await files.writes.flush();
      return remote.call(name, [path, ...args.slice(1)] as NodeFsArguments<K>, userSignal);
    })();
  };
  await fileSync.index();
  await refillLeases();
  const metadata = (path: string, follow = true) => {
    const entry = files.metadata(paths.resolve(path, follow));
    return entry.stat;
  };
  const mutations = createCliMetadataMutations({
    files,
    paths,
    remote,
    policy: () => policy,
    unlinkViews: (path) => views.unlink(path),
    renameViews: (from, to) => views.rename(from, to),
  });
  const descriptorMetadata = (
    fd: number,
    commit: () => Promise<void>,
    project: (stat: KernelStat) => KernelStat,
  ) => {
    const view = views.get(fd);
    const matches = files.entries.filter((item) =>
      item.pending
        ? item.path === view.path
        : view.stat.ino !== 0n &&
          item.stat.ino === view.stat.ino &&
          item.stat.dev === view.stat.dev,
    );
    const next = project(matches[0]?.stat ?? view.stat);
    files.writes.enqueue(0, commit);
    view.stat = next;
    files.project(matches.map((item) => withStat(item, next)))();
  };
  const backend: NodeFsBackend = {
    get cwd() {
      return paths.cwd;
    },
    get posixPolicy() {
      return policy;
    },
    descriptors: { get: (fd) => ({ offset: views.get(fd).offset }) },
    descriptorOffset: (fd, userSignal) => remote.position(fd, userSignal),
    changeGeneration: () => files.revision,
    resolvesThroughDescriptors: (path) =>
      /^\/(?:proc\/(?:self|\d+)\/fd|dev\/fd)\//.test(paths.absolute(path)),
    onDispose(listener) {
      disposals.add(listener);
      return () => {
        disposals.delete(listener);
      };
    },
    chdir(path) {
      paths.chdir(path);
    },
    setUmask(mask) {
      if (policy === undefined) throw kernelError("ENOTSUP");
      if (!Number.isInteger(mask) || mask < 0 || mask > 0o777) throw kernelError("EINVAL");
      const previous = policy.umask;
      policy = { ...policy, umask: mask };
      return previous;
    },
    stat: (path) => metadata(path),
    lstat: (path) => metadata(path, false),
    fstat: (fd) => views.stat(fd),
    readdir(path) {
      const canonical = paths.resolve(path);
      paths.assertAccess(files.metadata(canonical).stat, 4);
      return files.children(canonical);
    },
    readlink: (path) => {
      const entry = files.metadata(paths.resolve(path, false));
      if (entry.target === undefined) throw kernelError("EINVAL");
      return entry.target;
    },
    realpath: (path) => paths.resolve(path),
    open: (path, flags, mode) => views.open(path, flags, mode),
    close: (fd) => views.close(fd),
    read: (fd, target, position) => views.read(fd, target, position),
    write: (fd, source, position) => views.write(fd, source, position),
    ftruncate: (fd, size) => views.truncate(fd, size),
    truncate: (path, size) => {
      const fd = views.open(path, KernelOpenFlags.O_WRONLY);
      try {
        views.truncate(fd, size);
      } finally {
        views.close(fd);
      }
    },
    sync: (fd, dataOnly = false) => {
      views.get(fd);
      files.writes.order(async () => {
        await remote.sync(fd, dataOnly);
      });
    },
    access: mutations.access,
    chmod: mutations.chmod,
    chown: mutations.chown,
    setTimes: mutations.setTimes,
    mkdir: mutations.mkdir,
    rmdir: mutations.rmdir,
    unlink: mutations.unlink,
    symlink: mutations.symlink,
    link: mutations.link,
    rename: mutations.rename,
    fchmod(fd, mode) {
      descriptorMetadata(
        fd,
        () => remote.fchmod(fd, mode),
        (stat) => {
          if (stat.posix === undefined) throw kernelError("ENOTSUP");
          return { ...stat, posix: { ...stat.posix, mode } };
        },
      );
    },
    fchown(fd, uid, gid) {
      descriptorMetadata(
        fd,
        () => remote.fchown(fd, uid, gid),
        (stat) => {
          if (stat.posix === undefined) throw kernelError("ENOTSUP");
          return { ...stat, posix: { mode: stat.posix.mode & ~0o6000, uid, gid } };
        },
      );
    },
    fsetTimes(fd, times) {
      descriptorMetadata(
        fd,
        () => remote.fsetTimes(fd, times),
        (stat) => ({
          ...stat,
          ...(times.atimeNs === undefined ? {} : { atimeNs: times.atimeNs }),
          ...(times.mtimeNs === undefined ? {} : { mtimeNs: times.mtimeNs }),
        }),
      );
    },
    asynchronous: run,
    openAsync: (path, flags, mode, userSignal) => run("open", [path, flags, mode], userSignal),
    readAsync: (fd, target, position, userSignal) =>
      run("read", [fd, target, position], userSignal),
    renameAsync: (source, destination, userSignal) =>
      run("rename", [source, destination], userSignal),
  };
  // The last call into the view names what held the event loop when a timer comes back late.
  let lastOperation: string | undefined;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(backend))) {
    const method: unknown = descriptor.value;
    if (typeof method !== "function") continue;
    direct.set(name, method as (...args: unknown[]) => unknown);
    Object.defineProperty(backend, name, {
      ...descriptor,
      value(...args: unknown[]) {
        lastOperation = name;
        try {
          return Reflect.apply(method, backend, args);
        } catch (cause) {
          if (cause instanceof CliViewMiss) prefetcher.missed(name, cause);
          throw cause;
        }
      },
    });
  }
  const stopWatching = watchEventLoop({
    trace,
    activity: () => [fileSync.activity() ?? "no round", lastOperation ?? "no call"].join(", "),
  });
  disposals.add(stopWatching);
  return {
    backend,
    commit,
    barrier,
    beforeRemote,
    afterRemote,
    /** Keeps `fds` open in Computer for as long as a child inheriting them runs. */
    holdDescriptors: (fds: readonly number[]) => holds.hold(fds),
    /**
     * Writes to a descriptor a child inherited, as that child's stderr. The CLI may have closed its
     * own copy, which a hold keeps open in Computer, so this skips the CLI's descriptor check.
     */
    async writeDescriptor(fd: number, bytes: Uint8Array) {
      await barrier();
      for (let written = 0; written < bytes.byteLength;) {
        const count = await remote.write(fd, bytes.subarray(written), null);
        if (count === 0) throw kernelError("EIO");
        written += count;
      }
    },
    signalProcess(selector: number, number: number) {
      // Node's synchronous call queues delivery; the shared barrier exposes any owner rejection.
      files.writes.enqueue(0, () => kernel.signalProcess(selector, number));
    },
    refresh: barrier,
    async close() {
      const failures: unknown[] = [];
      for (const dispose of disposals)
        try {
          dispose();
        } catch (cause) {
          failures.push(cause);
        }
      disposals.clear();
      for (const close of [
        () => Promise.allSettled(operations),
        () => prefetcher.settled(),
        () => prefetcher.close(),
        () => files.writes.flush(),
        () => views.closeAll(),
        () => files.close(),
      ])
        try {
          await close();
        } catch (cause) {
          failures.push(cause);
        }
      if (failures.length > 0) throw new AggregateError(failures, "CLI filesystem cleanup failed");
    },
  };
}
