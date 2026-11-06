import type { ClaudeCliKernelPort } from "../ClaudeCliKernelPort.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";
import { CliWorkingSetLimit } from "./Budget.ts";
import { CliViewMiss } from "./Content.ts";
import type { CliFilePaths } from "./Paths.ts";
import { cliSyncReads, type CliSyncRoots } from "./SyncReads.ts";
import { parentOf, type CliFileWorkingSet } from "./WorkingSet.ts";
import { turnBudget } from "./Turn.ts";

/** A round that changes more files than this holds only those where the CLI read before. */
const CHANGED_FILES = 64;
/** Larger changed files are rarely read synchronously, and the next sync read fetches them. */
const CHANGED_FILE_BYTES = 64 * 1024;
const LEARNED = 256;

const skipped = (cause: unknown, codes: readonly string[]) =>
  cause instanceof CliViewMiss ||
  (typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    codes.includes(String(cause.code)));

/**
 * Holds the bytes the CLI reads synchronously: its own sync-read files, always, whatever their
 * size; any a caller names; files it read synchronously before; and the small files a round found
 * new or changed, which is how a child's output reaches a later sync read. Everything else it reads
 * from Computer asynchronously.
 */
export function createCliPrefetch(input: {
  readonly files: CliFileWorkingSet;
  readonly paths: CliFilePaths;
  readonly kernel: Pick<ClaudeCliKernelPort, "prefetch">;
  readonly roots: CliSyncRoots;
  readonly byteLimit: number;
  readonly extra: readonly string[];
  readonly trace: (event: CliViewTrace) => void;
  readonly signal: AbortSignal;
}) {
  const { files, paths, kernel, roots, signal } = input;
  const canonical = (path: string) => {
    try {
      return paths.resolve(path);
    } catch (cause) {
      if (skipped(cause, ["ENOENT", "ENOTDIR", "EACCES", "ELOOP"])) return undefined;
      throw cause;
    }
  };
  /** The CLI's own sync-read files stay pinned, so no other file's bytes ever evict them. */
  const pinned = new Map<string, () => void>();
  const fetch = async (requested: readonly string[], essential = false) => {
    const release: (() => void)[] = [];
    const turn = turnBudget();
    try {
      for (const path of requested) {
        await turn();
        const name = canonical(path);
        if (name === undefined) continue;
        const stat = files.metadata(name).stat;
        // One that can never fit would only evict everything else first.
        if (stat.type !== "file" || (!essential && stat.size > BigInt(input.byteLimit))) continue;
        try {
          paths.assertAccess(stat, 4);
          await files.prefetch(
            name,
            (offset, length) => kernel.prefetch(name, offset, length),
            signal,
            essential,
          );
        } catch (cause) {
          // Unreadable, the CLI's other held files fill the budget, or Computer moved meanwhile:
          // a later round fetches it again.
          if (cause instanceof CliWorkingSetLimit || skipped(cause, ["EACCES", "ESTALE"])) continue;
          throw cause;
        }
        // A concurrent projection can make the read moot; a later round fetches it again.
        if (!files.hasContent(name)) continue;
        if (!essential) {
          release.push(files.pin(name));
          continue;
        }
        // A new pin each time lets bytes a round replaced go.
        const previous = pinned.get(name);
        pinned.set(name, files.pin(name));
        previous?.();
      }
    } finally {
      for (const unpin of release) unpin();
    }
  };
  const source = {
    type(path: string) {
      try {
        return files.metadata(paths.resolve(path)).stat.type;
      } catch {
        return undefined;
      }
    },
    // Git's pointer files are a line each; nothing larger is parsed.
    text(path: string) {
      try {
        const name = paths.resolve(path);
        if (!files.hasContent(name)) return undefined;
        const bytes = files.content(name);
        return bytes.byteLength > 4096 ? undefined : new TextDecoder().decode(bytes);
      } catch {
        return undefined;
      }
    },
    children(path: string) {
      try {
        return files.children(paths.resolve(path));
      } catch {
        return [];
      }
    },
  };
  /** Paths and directories the CLI read synchronously that no policy named. */
  const learned = new Set<string>();
  const directories = new Set<string>();
  const covered = (changed: readonly string[]) => {
    const small = changed.filter((path) => {
      try {
        return files.metadata(path).stat.size <= BigInt(CHANGED_FILE_BYTES);
      } catch {
        return false;
      }
    });
    const near =
      small.length <= CHANGED_FILES
        ? small
        : small.filter((path) => directories.has(parentOf(path)));
    return near.slice(0, CHANGED_FILES);
  };
  // A fetched file can name the next one, as a gitfile its git directory and HEAD its branch.
  const hold = async (fetched: readonly string[]) => {
    const wanted = new Set<string>();
    const done = new Set(fetched);
    for (let pass = 0; pass < 4; pass++) {
      const essential = cliSyncReads(roots, source).filter((path) => !wanted.has(path));
      const others = [...input.extra, ...learned].filter(
        (path) => !wanted.has(path) && !done.has(path),
      );
      if (essential.length === 0 && others.length === 0) break;
      for (const path of [...essential, ...others]) wanted.add(path);
      await fetch(essential, true);
      await fetch(others);
    }
    // Policy files that stopped existing, or whose name now means another file, let go.
    for (const [name, unpin] of pinned)
      if (!files.hasContent(name)) {
        unpin();
        pinned.delete(name);
      }
  };
  // A round and a miss's own fetch never prefetch the same file at once.
  let fetching: Promise<unknown> = Promise.resolve();
  const healing = new Set<Promise<void>>();
  const exclusive = (work: () => Promise<void>) => {
    const next = fetching.then(work, work);
    fetching = next.catch(() => undefined);
    return next;
  };
  const rootOf = (path: string) => {
    const under = (root: string) => path === root || path.startsWith(`${root}/`);
    if (under(roots.cwd)) return "workspace" as const;
    return under(roots.home) || under(roots.configDir) ? ("home" as const) : ("other" as const);
  };
  /** A poller misses the same path every tick; one trace says so. */
  const traced = new Set<string>();
  return {
    /** These files' bytes, then whatever else the CLI reads synchronously that the view lacks. */
    prefetch: (held: readonly string[], changed: readonly string[] = []) =>
      exclusive(async () => {
        const requested = [...held, ...covered(changed)];
        await fetch(requested);
        await hold(requested);
      }),
    /** The CLI's call fails now; its next sync read finds the bytes, fetched in the background. */
    missed(operation: string, miss: CliViewMiss) {
      const key = `${miss.reason}:${miss.path}`;
      if (!traced.has(key)) {
        if (traced.size >= 1024) traced.clear();
        traced.add(key);
        input.trace({ kind: "sync-miss", operation, reason: miss.reason, root: rootOf(miss.path) });
      }
      if (miss.reason !== "content") return;
      if (learned.size < LEARNED) learned.add(miss.path);
      if (directories.size < LEARNED) directories.add(parentOf(miss.path));
      const heal = exclusive(() => fetch([miss.path])).catch(() => undefined);
      healing.add(heal);
      void heal.then(() => healing.delete(heal));
    },
    /** Resolves once the fetches misses started are done, so the CLI's next call finds them. */
    settled: () => Promise.all(healing),
    close() {
      for (const unpin of pinned.values()) unpin();
      pinned.clear();
    },
  };
}
