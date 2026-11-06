// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node stat watchers use the host scheduler and POSIX path identity.
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import type { NodeFsBackend } from "../../NodeFsBackend.ts";
import {
  nodeStats,
  type KernelStat,
  type NodeStats,
  type BigIntStats,
  type NodeStatsLike,
} from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";

type StatsListener = (current: NodeStats, previous: NodeStats) => void;
type BigIntStatsListener = (current: BigIntStats, previous: BigIntStats) => void;
type StatListener =
  | StatsListener
  | BigIntStatsListener
  | ((current: NodeStatsLike, previous: NodeStatsLike) => void);
interface WatchFileOptions {
  bigint?: boolean;
  persistent?: boolean;
  interval?: number;
}

function changed(current: KernelStat, previous: KernelStat): boolean {
  return (
    current.ino !== previous.ino ||
    current.dev !== previous.dev ||
    current.size !== previous.size ||
    current.mtimeNs !== previous.mtimeNs ||
    current.ctimeNs !== previous.ctimeNs ||
    current.nlink !== previous.nlink ||
    current.posix?.mode !== previous.posix?.mode ||
    current.posix?.uid !== previous.posix?.uid ||
    current.posix?.gid !== previous.posix?.gid
  );
}

const UNAVAILABLE = Symbol("unavailable");

/**
 * Node's stat poller never throws: a failed stat reads as zeroed Stats, as for a missing file. The
 * view's transient misses read as unavailable instead, so the tick keeps the last stat rather than
 * reporting a deletion, and the next tick asks again at the same interval.
 */
function sample(
  kernelFs: NodeFsBackend,
  path: string,
): KernelStat | undefined | typeof UNAVAILABLE {
  try {
    return kernelFs.stat(path);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
    return code === "ESTALE" || code === "EIO" ? UNAVAILABLE : undefined;
  }
}

class NodeStatWatcher extends NodeEvents.EventEmitter {
  #timer: ReturnType<typeof setInterval> | undefined;
  #unregister: (() => void) | undefined;

  constructor(interval: number, poll: () => void, close: () => void) {
    super();
    this.#timer = setInterval(poll, interval);
    this.once("stop", close);
  }

  registerCleanup(unregister: () => void): void {
    this.#unregister = unregister;
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unregister?.();
    this.#unregister = undefined;
    this.emit("stop");
  }

  ref(): this {
    (this.#timer as unknown as { ref?: () => void } | undefined)?.ref?.();
    return this;
  }

  unref(): this {
    (this.#timer as unknown as { unref?: () => void } | undefined)?.unref?.();
    return this;
  }
}

export function createWatchFile(kernelFs: NodeFsBackend) {
  const watchers = new Map<string, NodeStatWatcher>();
  function watchFile(path: PathLike, listener: StatsListener): NodeStatWatcher;
  function watchFile(
    path: PathLike,
    options: WatchFileOptions & { bigint: true },
    listener: BigIntStatsListener,
  ): NodeStatWatcher;
  function watchFile(
    path: PathLike,
    options: WatchFileOptions & { bigint?: false },
    listener: StatsListener,
  ): NodeStatWatcher;
  function watchFile(
    path: PathLike,
    options: WatchFileOptions,
    listener: StatListener,
  ): NodeStatWatcher;
  function watchFile(
    path: PathLike,
    optionsOrListener: WatchFileOptions | StatListener,
    suppliedListener?: StatListener,
  ): NodeStatWatcher {
    const options = typeof optionsOrListener === "function" ? {} : optionsOrListener;
    const listener = typeof optionsOrListener === "function" ? optionsOrListener : suppliedListener;
    if (typeof listener !== "function") {
      throw Object.assign(new TypeError('The "listener" argument must be a function'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    const interval = options.interval ?? 5007;
    if (!Number.isFinite(interval) || interval < 0 || interval > 2_147_483_647) {
      throw Object.assign(new RangeError('The "interval" argument is out of range'), {
        code: "ERR_OUT_OF_RANGE",
      });
    }
    const filename = NodePath.posix.resolve(kernelFs.cwd, pathString(path));
    const existing = watchers.get(filename);
    if (existing !== undefined) {
      existing.on("change", listener);
      return existing;
    }
    const initial = sample(kernelFs, filename);
    // Without a first stat, the first one a tick gets is the baseline.
    let known = initial !== UNAVAILABLE;
    let previous = initial === UNAVAILABLE ? undefined : initial;
    let missing = previous === undefined;
    let initialMissing = missing;
    const watcher = new NodeStatWatcher(
      Math.max(1, Math.trunc(interval)),
      () => {
        const current = sample(kernelFs, filename);
        if (current === UNAVAILABLE) return;
        if (!known) {
          known = true;
          previous = current;
          missing = initialMissing = current === undefined;
          return;
        }
        const notify =
          current === undefined
            ? !missing || initialMissing
            : missing || previous === undefined || changed(current, previous);
        initialMissing = false;
        missing = current === undefined;
        if (!notify) return;
        // Node preserves the last existing stat across deletion and recreation.
        const prior = previous;
        if (current !== undefined) previous = current;
        watcher.emit(
          "change",
          nodeStats(current, options.bigint),
          nodeStats(prior, options.bigint),
        );
      },
      () => {
        watchers.delete(filename);
      },
    );
    watcher.on("change", listener);
    watcher.registerCleanup(kernelFs.onDispose(() => watcher.stop()));
    watchers.set(filename, watcher);
    if (options.persistent === false) watcher.unref();
    return watcher;
  }

  function unwatchFile(path: PathLike, listener?: StatListener): void {
    if (listener !== undefined && typeof listener !== "function") {
      throw Object.assign(new TypeError('The "listener" argument must be a function'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    const filename = NodePath.posix.resolve(kernelFs.cwd, pathString(path));
    const watcher = watchers.get(filename);
    if (watcher === undefined) return;
    if (listener === undefined) watcher.removeAllListeners("change");
    else watcher.removeListener("change", listener);
    if (watcher.listenerCount("change") === 0) watcher.stop();
  }

  return { watchFile, unwatchFile };
}
