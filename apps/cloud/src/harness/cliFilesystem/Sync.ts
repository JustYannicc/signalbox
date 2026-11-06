import { kernelError } from "../../kernel/KernelErrno.ts";
import type { ClaudeCliKernelPort, ClaudeCliLookup } from "../ClaudeCliKernelPort.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";
import { parentOf, sameFile, type CliFileMetadata, type CliFileWorkingSet } from "./WorkingSet.ts";
import type { CliDescriptorViews } from "./Descriptors.ts";
import type { CliProjectionSnapshot } from "./Projections.ts";
import { sha256Hex, UNCHANGED_DIGEST } from "./Digest.ts";
import { turnBudget } from "./Turn.ts";

/** Only a full index reproduces denial handling and the machine's unlisted changes. */
class IndexRequired extends Error {}

type Update = CliFileMetadata | { readonly path: string; readonly removed: true };

const childOf = (parent: string, name: string) => `${parent === "/" ? "" : parent}/${name}`;

/**
 * Keeps the read view in step with Computer. A round re-reads only paths whose inodes changed
 * and the CLI's own unconfirmed projections; a full index is the fallback when Computer can't
 * list its changes.
 */
export function createCliFileSync(input: {
  readonly files: CliFileWorkingSet;
  readonly views: CliDescriptorViews;
  readonly kernel: Pick<ClaudeCliKernelPort, "metadata" | "changes" | "lookup" | "digest">;
  readonly metadataLimit: number;
  readonly requested: readonly string[];
  readonly prefetch: (paths: readonly string[]) => Promise<void>;
  /** The view's canonical name for a path, or undefined when it has none. */
  readonly canonical: (path: string) => string | undefined;
  readonly trace?: (event: CliViewTrace) => void;
}) {
  const { files, views, kernel } = input;
  const trace = input.trace ?? (() => {});
  let active: "incremental" | "index" | undefined;
  const lookup = async (paths: readonly string[]) => {
    const results: ClaudeCliLookup[] = [];
    for (let offset = 0; offset < paths.length; offset += 512)
      results.push(...(await kernel.lookup(paths.slice(offset, offset + 512))));
    return results;
  };

  const index = async (snapshot?: CliProjectionSnapshot) => {
    const started = performance.now();
    active = "index";
    const known = files.paths.length > 0 ? files.entries.length : 0;
    trace({ kind: "round", phase: "start", mode: "index", entries: known });
    let indexed: number | undefined;
    try {
      indexed = await reindex(snapshot);
    } finally {
      active = undefined;
      trace({
        kind: "round",
        phase: "end",
        mode: "index",
        entries: indexed ?? 0,
        durationMs: Math.round(performance.now() - started),
        ...(indexed === undefined ? { failed: true as const } : {}),
      });
    }
  };

  const reindex = async (snapshot?: CliProjectionSnapshot) => {
    // Cached bytes imply the view already has a revision Computer issued.
    const since = files.paths.length > 0 ? files.revision : undefined;
    const entries: CliFileMetadata[] = [];
    let cursor = 0;
    let revision: number | undefined;
    do {
      const page = await kernel.metadata(cursor, revision);
      revision ??= page.revision;
      if (page.revision !== revision || (page.next !== null && page.next <= cursor))
        throw kernelError("ESTALE");
      entries.push(...page.entries);
      if (entries.length > input.metadataLimit) throw kernelError("E2BIG");
      cursor = page.next ?? -1;
    } while (cursor >= 0);
    const requested = [...new Set([...input.requested, ...files.paths])];
    files.replaceMetadata(revision!, entries, await verify(entries, since), snapshot);
    views.releaseNamedContent();
    await input.prefetch(requested);
    await views.refresh();
    return entries.length;
  };

  // Without a change feed, only a digest proves cached bytes still match: clocks are coarse, so
  // inode, size and mtime can all repeat across a rewrite.
  const verify = async (entries: readonly CliFileMetadata[], since: number | undefined) => {
    const verified = new Set<string>();
    const turn = turnBudget(16);
    const cached = files.paths.filter((path) => !files.projections.projected(path));
    if (cached.length === 0) return verified;
    const before = new Map(files.entries.map((entry) => [entry.path, entry.stat]));
    const next = new Map(entries.map((entry) => [entry.path, entry.stat]));
    const candidates = cached.filter((path) => sameFile(before.get(path), next.get(path)));
    for (let offset = 0; offset < candidates.length; offset += 256) {
      const batch = candidates.slice(offset, offset + 256).map((path) => ({
        path,
        size: Number(next.get(path)!.size),
      }));
      const bytes = batch.reduce((total, file) => total + file.size, 0);
      const started = performance.now();
      trace({ kind: "digest", phase: "start", files: batch.length, bytes });
      const remote = await kernel.digest(batch, since);
      let unchanged = 0;
      for (const [index, { path }] of batch.entries()) {
        const digest = remote[index];
        // Computer proved these bytes unchanged from its change feed without reading them.
        if (digest === UNCHANGED_DIGEST) {
          unchanged++;
          verified.add(path);
          continue;
        }
        if (digest === null || digest === undefined) continue;
        // One cached file at a time: each read copies its bytes.
        const local = files.content(path);
        if ((await sha256Hex(local)) === digest) verified.add(path);
        await turn(local.byteLength);
      }
      trace({
        kind: "digest",
        phase: "end",
        files: batch.length,
        bytes,
        unchanged,
        durationMs: Math.round(performance.now() - started),
      });
    }
    return verified;
  };

  const incremental = async (
    revision: number,
    inodes: readonly bigint[],
    names: readonly { readonly parent: bigint; readonly name: string }[],
    snapshot: CliProjectionSnapshot,
  ) => {
    const changed = new Set(inodes);
    const entries = files.entries;
    const reread = new Set(snapshot.keys());
    for (const entry of entries)
      if (entry.pending || changed.has(entry.stat.ino)) reread.add(entry.path);
    if (names.length > 0) {
      // A name re-pointed at a new inode, as by an overlay copy-up, is listed by its directory.
      const directories = new Map<bigint, string[]>();
      for (const entry of entries)
        if (entry.stat.type === "directory" && !entry.pending) {
          const list = directories.get(entry.stat.ino);
          if (list === undefined) directories.set(entry.stat.ino, [entry.path]);
          else list.push(entry.path);
        }
      for (const { parent, name } of names)
        for (const directory of directories.get(parent) ?? []) reread.add(childOf(directory, name));
    }
    const known = new Map(entries.map((entry) => [entry.path, entry]));
    let index: Map<string, string[]> | undefined;
    // Built only when a read needs it; most rounds touch a few files and no directories.
    const childrenOf = (path: string) => {
      if (index === undefined) {
        index = new Map();
        for (const entry of entries) {
          if (entry.path === "/") continue;
          const parent = parentOf(entry.path);
          const list = index.get(parent);
          if (list === undefined) index.set(parent, [entry.path]);
          else list.push(entry.path);
        }
      }
      return index.get(path) ?? [];
    };
    const updates = new Map<string, Update>();
    const remove = (path: string) => {
      updates.set(path, { path, removed: true });
      for (const child of childrenOf(path)) remove(child);
    };
    let fresh: string[] = [];
    const record = (result: ClaudeCliLookup) => {
      const before = known.get(result.path);
      if ("denied" in result) throw new IndexRequired();
      if ("missing" in result) {
        if (before !== undefined) remove(result.path);
        return;
      }
      if (before?.unindexed || before?.directoryDenial !== undefined || before?.children)
        throw new IndexRequired();
      const entry = result.entry;
      const replaced =
        before !== undefined &&
        (before.stat.type !== entry.stat.type ||
          (!before.pending && before.stat.ino !== entry.stat.ino));
      updates.set(result.path, entry);
      if (result.names === undefined) {
        if (replaced) for (const child of childrenOf(result.path)) remove(child);
        return;
      }
      const listed = new Set(result.names.map((name) => childOf(result.path, name)));
      for (const child of childrenOf(result.path)) if (!listed.has(child)) remove(child);
      // A replaced directory, such as one an overlay copy-up gave a new inode, keeps names whose
      // entries may not have changed. Each is read again; one that kept its inode keeps its subtree.
      for (const child of listed) if (replaced || !known.has(child)) fresh.push(child);
    };
    // Parents first, so a child read in the same batch is not undone by its parent's listing.
    for (const result of await lookup([...reread].sort())) record(result);
    let added = 0;
    while (fresh.length > 0) {
      const queue = fresh;
      fresh = [];
      added += queue.length;
      if (known.size + added > input.metadataLimit) throw kernelError("E2BIG");
      for (const result of await lookup(queue)) record(result);
    }
    const evict: string[] = [];
    const prefetch: string[] = [];
    for (const [path, update] of updates) {
      if ("removed" in update || !files.hasContent(path)) continue;
      const mark = snapshot.get(path);
      // The CLI projected these bytes itself and Computer has committed them.
      if (mark !== undefined && !mark.remote) continue;
      evict.push(path);
      if (update.stat.type === "file") prefetch.push(path);
    }
    const applied = files.sync(revision, [...updates.values()], evict, snapshot);
    // Requested files that this round created or replaced are prefetched like at startup.
    for (const path of input.requested) {
      const canonical = input.canonical(path);
      const update = canonical === undefined ? undefined : updates.get(canonical);
      if (update !== undefined && !("removed" in update)) prefetch.push(canonical!);
    }
    const evicted = new Set(evict);
    views.releaseNamedContent((view) => evicted.has(view.path));
    await input.prefetch(prefetch);
    await views.refresh((view) => changed.has(view.stat.ino) || applied.has(view.path));
    return reread.size;
  };

  const round = async () => {
    await files.writes.flush();
    const snapshot = files.projections.snapshot();
    const changes = await kernel.changes(files.revision);
    if (changes.inodes !== null)
      try {
        const started = performance.now();
        active = "incremental";
        const reread = await incremental(changes.revision, changes.inodes, changes.names, snapshot);
        const durationMs = Math.round(performance.now() - started);
        // Most rounds re-read a handful of paths; only slow or wide ones are worth a journal line.
        if (durationMs >= 100 || reread >= 256)
          trace({
            kind: "round",
            phase: "end",
            mode: "incremental",
            entries: files.entries.length,
            reread,
            durationMs,
          });
        return;
      } catch (cause) {
        if (!(cause instanceof IndexRequired)) throw cause;
      } finally {
        active = undefined;
      }
    // At most one index per round: while a machine command runs Computer can't list changes,
    // and the next round would only index again. The index confirms the projections it read.
    await index(snapshot);
  };

  return { index, round, activity: () => active };
}
