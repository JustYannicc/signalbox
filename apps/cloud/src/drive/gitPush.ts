import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DriveDirectory, type DriveHandle } from "./DriveDirectory.ts";
import type { StoredCommit } from "./DriveStore.ts";
import { makeDriveReader } from "./DriveReader.ts";
import { concatBytes as concat, type ObjectType, type Oid } from "./git/gitObjects.ts";
import { packSize, planEntries, type PushEntry, streamPack } from "./pushPack.ts";

/**
 * Pushing one branch of a drive to its remote over git's smart HTTP, with no
 * machine (#135). The drive's commit index says which commits the remote
 * lacks: walking back from the branch stops at a commit the remote has (the
 * branch's base, or what was pushed before) or one the drive does not hold
 * (a remote-backed drive keeps the remote's history one commit deep). Their
 * objects are read from the drive's packs, diffing each commit's tree against
 * its first parent's, and streamed to the remote as the drive's packs store
 * them (`pushPack.ts`), so a push of any size holds no more in memory than a
 * small one.
 *
 * Only the branch named is pushed, so nothing else in the drive, such as its
 * auto-saves, ever reaches the remote. What the host would refuse, a file or a
 * whole push too big for it, is refused here first, saying which, and nothing
 * is sent.
 */

export class PushRefused extends Schema.TaggedError<PushRefused>()("PushRefused", {
  message: Schema.String,
  /** The remote's branch has commits the pushed one doesn't. */
  diverged: Schema.optional(Schema.Boolean),
}) {}

/** What one push to a git host may hold. */
export interface HostLimits {
  /** The host, as people know it. */
  readonly host: string;
  /** The biggest file it takes. */
  readonly maxFileBytes: number;
  /** The biggest push, the pack as sent. */
  readonly maxPushBytes: number;
  /** Why pushes stop at `maxPushBytes` when that's below what the host itself takes. */
  readonly pushLimitReason?: string;
}

/**
 * GitHub refuses files over 100 MB and pushes over 2 GB (docs: "Repository
 * limits"). A push leaves from a Worker, though, and on the current
 * Cloudflare plan a Worker's request is cut off past its 100 MB request body
 * limit: an 80 MB push went through and a 110 MB one was cut off (#660). So
 * a push stops below it, and says why, until the plan changes.
 */
export const GITHUB_LIMITS: HostLimits = {
  host: "GitHub",
  maxFileBytes: 100 * 1024 * 1024,
  maxPushBytes: 95 * 1024 * 1024,
  pushLimitReason: "on the current Cloudflare plan, which caps a request's body at 100 MB",
};

const ZERO_OID: Oid = "0".repeat(40);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MB = 1024 * 1024;
/** Rounded up, so a size just over a limit never reads as the limit. */
const formatSize = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${Math.ceil((bytes / (1024 * MB)) * 10) / 10} GB`
    : `${Math.ceil(bytes / MB)} MB`;

const pktLine = (line: string) => {
  const bytes = encoder.encode(line);
  return concat([encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
};

/**
 * The body of a `git-receive-pack` request that moves `ref` from `old` to
 * `next`, streaming `pack` of `size` bytes, and its length.
 */
export const receivePackRequest = <E>(input: {
  readonly ref: string;
  readonly old: Oid | null;
  readonly next: Oid;
  readonly pack: Stream.Stream<Uint8Array, E>;
  readonly size: number;
}) => {
  const commands = concat([
    pktLine(
      `${input.old ?? ZERO_OID} ${input.next} ${input.ref}\0report-status object-format=sha1 agent=signalbox\n`,
    ),
    encoder.encode("0000"),
  ]);
  return {
    body: Stream.concat(Stream.make(commands), input.pack),
    length: commands.length + input.size,
  };
};

/** Reads `report-status`: whether the remote unpacked the pack and moved `ref`, or why not. */
export function receivePackResult(
  body: Uint8Array,
  ref: string,
): { readonly _tag: "ok" } | { readonly _tag: "refused"; readonly reason: string } {
  const lines: Array<string> = [];
  for (let at = 0; at + 4 <= body.length;) {
    const length = parseInt(decoder.decode(body.subarray(at, at + 4)), 16);
    if (!Number.isFinite(length)) break;
    if (length < 4) {
      at += 4;
      continue;
    }
    lines.push(decoder.decode(body.subarray(at + 4, at + length)).replace(/\n$/, ""));
    at += length;
  }
  const error = lines.find((line) => line.startsWith("ERR "));
  if (error !== undefined) return { _tag: "refused", reason: error.slice(4) };
  const unpack = lines.find((line) => line.startsWith("unpack "));
  if (unpack !== undefined && unpack !== "unpack ok") {
    return { _tag: "refused", reason: `The remote could not unpack the push: ${unpack.slice(7)}.` };
  }
  if (lines.includes(`ok ${ref}`)) return { _tag: "ok" };
  const rejected = lines.find((line) => line.startsWith(`ng ${ref} `));
  return {
    _tag: "refused",
    reason:
      rejected?.slice(`ng ${ref} `.length) ?? "The remote did not say whether it took the push.",
  };
}

/**
 * Commits on `head`'s history that are not behind any of `stop`, newest
 * first, walked through the drive's commit index. A parent the drive does
 * not hold ends the walk too: it is on the remote. `reached` says which of
 * `stop` the walk ran into.
 */
export const commitsSince = (drive: DriveHandle, head: Oid, stop: ReadonlySet<Oid>) =>
  Effect.gen(function* () {
    const commits: Array<StoredCommit> = [];
    const reached = new Set<Oid>();
    const seen = new Set<Oid>();
    let frontier: ReadonlyArray<Oid> = [head];
    while (frontier.length > 0) {
      const wanted = frontier.filter((oid) => {
        if (stop.has(oid)) reached.add(oid);
        if (stop.has(oid) || seen.has(oid)) return false;
        seen.add(oid);
        return true;
      });
      const found = yield* drive.commits(wanted);
      commits.push(...found);
      frontier = found.flatMap((commit) => commit.parents);
    }
    return { commits, reached };
  });

/**
 * The pack that brings a remote from `remoteHas` to `head`: every commit on
 * `head` it lacks and the objects they add. `old`, the remote branch's
 * current commit, must be on `head`'s history, so a push never drops commits
 * someone else added to the branch, unless `force`: the thread took exactly
 * `old` in and rewrote its branch (a lease, #394), and the push replaces it.
 * Of the files, only each one's header is read until the pack streams.
 */
export const packForPush = Effect.fn("gitPush.packForPush")(function* (input: {
  readonly driveId: string;
  readonly head: Oid;
  readonly old: Oid | null;
  readonly remoteHas: ReadonlyArray<Oid>;
  readonly limits: HostLimits;
  readonly force?: boolean;
}) {
  const reader = yield* makeDriveReader(input.driveId);
  const drive = (yield* DriveDirectory).forDrive(input.driveId);
  const stop = new Set([...input.remoteHas, ...(input.old === null ? [] : [input.old])]);
  const walked = yield* commitsSince(drive, input.head, stop);
  const commits = walked.commits.map((commit) => ({
    oid: commit.oid,
    tree: commit.tree,
    parent: commit.parents[0] ?? null,
  }));
  if (
    input.force !== true &&
    input.old !== null &&
    input.old !== input.head &&
    !walked.reached.has(input.old)
  ) {
    return yield* new PushRefused({
      message: "The branch on the remote has commits this thread does not. Nothing was pushed.",
      diverged: true,
    });
  }

  const parentTrees = new Map<Oid, Oid>();
  const parents = commits.flatMap((commit) => (commit.parent === null ? [] : [commit.parent]));
  for (const commit of yield* drive.commits(parents)) parentTrees.set(commit.oid, commit.tree);

  // Trees and blobs each commit adds over its first parent, and where each file first shows.
  const objects = new Map<Oid, ObjectType>(commits.map((commit) => [commit.oid, "commit"]));
  const paths = new Map<Oid, string>();
  // What those replace in a parent the remote has: the bases deltas likely lean on.
  const onRemote = new Set<Oid>();
  const pushed = new Set(commits.map((commit) => commit.oid));
  type ReadFailure = Effect.Error<ReturnType<typeof reader.tree>>;
  const collect = (
    after: Oid,
    before: Oid | null,
    remoteHasBefore: boolean,
    prefix = "",
  ): Effect.Effect<void, ReadFailure> =>
    Effect.gen(function* () {
      if (after === before || objects.has(after)) return;
      objects.set(after, "tree");
      const previous = new Map(
        (before === null ? [] : yield* reader.tree(before)).map((entry) => [entry.name, entry]),
      );
      for (const entry of yield* reader.tree(after)) {
        const old = previous.get(entry.name);
        if (old?.oid === entry.oid) continue;
        if (old !== undefined && remoteHasBefore) onRemote.add(old.oid);
        const path = `${prefix}${entry.name}`;
        if (entry.kind === "directory") {
          const inside = old?.kind === "directory" ? old.oid : null;
          yield* collect(entry.oid, inside, remoteHasBefore, `${path}/`);
        } else if (entry.kind !== "submodule") {
          objects.set(entry.oid, "blob");
          if (!paths.has(entry.oid)) paths.set(entry.oid, path);
        }
      }
    });
  for (const commit of commits) {
    const parent = commit.parent;
    yield* collect(
      commit.tree,
      parent === null ? null : (parentTrees.get(parent) ?? null),
      parent !== null && !pushed.has(parent),
    );
  }

  const entries = yield* planEntries(input.driveId, objects, onRemote);
  const size = yield* checkLimits(entries, paths, input.limits);
  return {
    pack: yield* streamPack(input.driveId, entries),
    size,
    commits: commits.length,
    objects: entries.length,
  };
});

/** The pack's size, or what the host would refuse in it, before any of it is sent. */
const checkLimits = (
  entries: ReadonlyArray<PushEntry>,
  paths: ReadonlyMap<Oid, string>,
  limits: HostLimits,
) =>
  Effect.gen(function* () {
    const big = entries.filter(
      (entry) => entry.type === "blob" && entry.size > limits.maxFileBytes,
    );
    if (big.length > 0) {
      const named = big
        .slice(0, 3)
        .map(
          (entry) =>
            `${paths.get(entry.oid) ?? `a file (${entry.oid.slice(0, 7)})`} (${formatSize(entry.size)})`,
        );
      const more = big.length > 3 ? ` and ${big.length - 3} more` : "";
      const [is, them] = big.length === 1 ? ["is", "it"] : ["are", "them"];
      return yield* new PushRefused({
        message:
          `${named.join(", ")}${more} ${is} too big: ${limits.host} takes files up to ` +
          `${formatSize(limits.maxFileBytes)}. Nothing was pushed. Take ${them} out of the ` +
          `branch's commits (deleting ${them} in a later commit leaves ${them} in its history), then push again.`,
      });
    }
    const size = packSize(entries);
    if (size > limits.maxPushBytes) {
      const limit = formatSize(limits.maxPushBytes);
      return yield* new PushRefused({
        message:
          `This push is ${formatSize(size)}: ` +
          (limits.pushLimitReason === undefined
            ? `${limits.host} takes pushes up to ${limit}. `
            : `Signalbox sends ${limits.host} pushes of up to ${limit} ${limits.pushLimitReason}. `) +
          "Nothing was pushed. Keep large generated files out of the branch, or push the work in smaller commits one push at a time.",
      });
    }
    return size;
  });
