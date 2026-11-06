import { kernelError } from "../../kernel/KernelErrno.ts";
import type { ClaudeCliKernelPort, ClaudeCliLookup } from "../ClaudeCliKernelPort.ts";
import { parentOf, type CliFileMetadata, type CliFileWorkingSet } from "./WorkingSet.ts";
import type { CliDescriptorViews } from "./Descriptors.ts";
import type { CliProjectionSnapshot } from "./Projections.ts";

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
  readonly kernel: Pick<ClaudeCliKernelPort, "metadata" | "changes" | "lookup">;
  readonly metadataLimit: number;
  readonly requested: readonly string[];
  readonly prefetch: (paths: readonly string[]) => Promise<void>;
  /** The view's canonical name for a path, or undefined when it has none. */
  readonly canonical: (path: string) => string | undefined;
}) {
  const { files, views, kernel } = input;
  const lookup = async (paths: readonly string[]) => {
    const results: ClaudeCliLookup[] = [];
    for (let offset = 0; offset < paths.length; offset += 512)
      results.push(...(await kernel.lookup(paths.slice(offset, offset + 512))));
    return results;
  };

  const index = async () => {
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
    files.replaceMetadata(revision!, entries);
    views.releaseNamedContent();
    await input.prefetch(requested);
    await views.refresh();
  };

  const incremental = async (
    revision: number,
    inodes: readonly bigint[],
    snapshot: CliProjectionSnapshot,
  ) => {
    const changed = new Set(inodes);
    const entries = files.entries;
    const reread = new Set(snapshot.keys());
    for (const entry of entries)
      if (entry.pending || changed.has(entry.stat.ino)) reread.add(entry.path);
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
      if (replaced) for (const child of childrenOf(result.path)) remove(child);
      updates.set(result.path, entry);
      if (result.names === undefined) return;
      const listed = new Set(result.names.map((name) => childOf(result.path, name)));
      if (!replaced)
        for (const child of childrenOf(result.path)) if (!listed.has(child)) remove(child);
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
    files.sync(revision, [...updates.values()], evict, snapshot);
    // Requested files that this round created or replaced are prefetched like at startup.
    for (const path of input.requested) {
      const canonical = input.canonical(path);
      const update = canonical === undefined ? undefined : updates.get(canonical);
      if (update !== undefined && !("removed" in update)) prefetch.push(canonical!);
    }
    const evicted = new Set(evict);
    views.releaseNamedContent((view) => evicted.has(view.path));
    await input.prefetch(prefetch);
    await views.refresh((view) => changed.has(view.stat.ino) || updates.has(view.path));
  };

  const round = async () => {
    for (let attempt = 0; ; attempt++) {
      await files.writes.flush();
      const snapshot = files.projections.snapshot();
      const changes = await kernel.changes(files.revision);
      try {
        if (changes.inodes === null) throw new IndexRequired();
        await incremental(changes.revision, changes.inodes, snapshot);
        return;
      } catch (cause) {
        if (!(cause instanceof IndexRequired)) throw cause;
      }
      await index();
      // The index is current; projections it kept are confirmed by a later round.
      if (attempt === 2) return;
    }
  };

  return { index, round };
}
