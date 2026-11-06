import type { ClaudeCliKernelPort } from "../ClaudeCliKernelPort.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";
import { CliWorkingSetLimit } from "./Budget.ts";
import { CliViewMiss } from "./Content.ts";
import type { CliFilePaths } from "./Paths.ts";
import { cliSyncReads, type CliSyncRoots } from "./SyncReads.ts";
import type { CliFileWorkingSet } from "./WorkingSet.ts";
import { turnBudget } from "./Turn.ts";

const skipped = (cause: unknown, codes: readonly string[]) =>
  cause instanceof CliViewMiss ||
  (typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    codes.includes(String(cause.code)));

/**
 * Holds the bytes the CLI reads synchronously, and only those: its own sync-read files, any a
 * caller names, and any it read synchronously that neither named. Everything else it reads from
 * Computer asynchronously.
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
  const fetch = async (requested: readonly string[]) => {
    const release: (() => void)[] = [];
    const turn = turnBudget();
    try {
      for (const path of requested) {
        await turn();
        let canonical;
        try {
          canonical = paths.resolve(path);
        } catch (cause) {
          if (skipped(cause, ["ENOENT", "ENOTDIR", "EACCES", "ELOOP"])) continue;
          throw cause;
        }
        const stat = files.metadata(canonical).stat;
        // One that can never fit would only evict everything else first.
        if (stat.type !== "file" || stat.size > BigInt(input.byteLimit)) continue;
        try {
          paths.assertAccess(stat, 4);
          await files.prefetch(
            canonical,
            (offset, length) => kernel.prefetch(canonical, offset, length),
            signal,
          );
        } catch (cause) {
          // Unreadable, the CLI's other held files fill the budget, or Computer moved meanwhile:
          // a sync read gets EIO, and a later round fetches it again.
          if (cause instanceof CliWorkingSetLimit || skipped(cause, ["EACCES", "ESTALE"])) continue;
          throw cause;
        }
        // A concurrent projection can make the read moot; a later round fetches it again.
        if (files.hasContent(canonical)) release.push(files.pin(canonical));
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
        const canonical = paths.resolve(path);
        if (!files.hasContent(canonical)) return undefined;
        const bytes = files.content(canonical);
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
  const learned = new Set<string>();
  // A fetched file can name the next one, as a gitfile its git directory and HEAD its branch.
  const hold = async (fetched: readonly string[]) => {
    const wanted = new Set(fetched);
    for (let pass = 0; pass < 4; pass++) {
      const next = [...input.extra, ...learned, ...cliSyncReads(roots, source)].filter(
        (path) => !wanted.has(path),
      );
      if (next.length === 0) return;
      for (const path of next) wanted.add(path);
      await fetch(next);
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
  return {
    /** These files' bytes, then whatever else the CLI reads synchronously that the view lacks. */
    prefetch: (requested: readonly string[]) =>
      exclusive(async () => {
        await fetch(requested);
        await hold(requested);
      }),
    /** The CLI's call fails now; its next sync read finds the bytes, fetched in the background. */
    missed(operation: string, miss: CliViewMiss) {
      input.trace({ kind: "sync-miss", operation, reason: miss.reason, root: rootOf(miss.path) });
      if (miss.reason !== "content") return;
      if (learned.size < 256) learned.add(miss.path);
      const heal = exclusive(() => fetch([miss.path])).catch(() => undefined);
      healing.add(heal);
      void heal.then(() => healing.delete(heal));
    },
    /** Resolves once the fetches misses started are done, so the CLI's next call finds them. */
    settled: () => Promise.all(healing),
  };
}
