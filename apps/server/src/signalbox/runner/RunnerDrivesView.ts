import type {
  ContextDrive,
  ContextEntry,
  ContextView,
  TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import { contextJson } from "@signalbox/runner-protocol/ContextProtocol";
import { isWithin, pathSegments } from "@signalbox/runner-protocol/drivePaths";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { ContextClient, ContextClientError } from "./RunnerContextClient.ts";

/**
 * `/drives` as this machine sees it during one turn (#141): every drive the
 * thread's user can read, laid out by context like Google Drive, each read at
 * the commit the turn's view pinned. `pin` takes a new view at each turn
 * start; between turns the last one stands.
 *
 *   /drives/<context>/My Drive/…
 *   /drives/<context>/Shared drives/<name>/…
 *   /drives/<context>/Shared with me/<name>/…
 *
 * Shortcuts inside a drive read from the drive they point at, at that drive's
 * pinned commit. `at` reads one drive at another of its commits instead: an
 * older version, or a thread's unreconciled work the search found. Trees and
 * files never change at a commit, so both are cached for the machine's life.
 */

export const DRIVES_ROOT = "/drives";

export interface DrivesEntry {
  readonly name: string;
  readonly kind: ContextEntry["kind"];
  readonly size: number;
  /** Seconds since the epoch: the pinned commit's time, or the view's. */
  readonly time: number;
}

export type DrivesNode =
  | { readonly _tag: "directory"; readonly time: number }
  | {
      readonly _tag: "file";
      readonly entry: DrivesEntry;
      readonly driveId: string;
      readonly oid: string;
    }
  | { readonly _tag: "missing" };

export type DrivesRead =
  | { readonly _tag: "file"; readonly bytes: Uint8Array }
  | { readonly _tag: "directory" | "missing" | "too_large" };

/** Where a path lands: a folder `/drives` makes up, or a path inside one drive at one commit. */
type Place =
  | { readonly _tag: "virtual"; readonly entries: ReadonlyArray<string> }
  | {
      readonly _tag: "drive";
      readonly drive: ContextDrive;
      readonly commit: string | null;
      readonly path: string;
    }
  | { readonly _tag: "missing" };

/** Path segments under `/drives`, or null for a path outside it or one that climbs out. */
export const drivesSegments = (path: string): ReadonlyArray<string> | null => {
  const trimmed = path.trim();
  const relative =
    trimmed === DRIVES_ROOT || trimmed === `${DRIVES_ROOT}/`
      ? ""
      : trimmed.startsWith(`${DRIVES_ROOT}/`)
        ? trimmed.slice(DRIVES_ROOT.length + 1)
        : trimmed.startsWith("/")
          ? null
          : trimmed;
  return relative === null ? null : pathSegments(relative);
};

const BLOB_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_TREES = 20_000;

export const makeDrivesView = () => {
  let view: ContextView | null = null;
  let client: ContextClient | null = null;
  /** When the view was taken, in seconds: the time of folders `/drives` makes up. */
  let pinnedAt = 0;
  const trees = new Map<string, TreeResult>();
  /** Listings being fetched, so concurrent reads of one folder make one request. */
  const fetching = new Map<string, Deferred.Deferred<TreeResult, ContextClientError>>();
  const blobs = new Map<string, Uint8Array>();
  let blobBytes = 0;

  const drives = () => view?.contexts.flatMap((context) => context.drives) ?? [];
  const byId = (driveId: string) => drives().find((drive) => drive.driveId === driveId) ?? null;

  /** The `/drives` path of a drive: where it is listed, or where a shortcut shows it. */
  const drivePath = (driveId: string): string | null => {
    for (const context of view?.contexts ?? []) {
      const drive = context.drives.find((candidate) => candidate.driveId === driveId);
      if (drive?.path != null) return `${DRIVES_ROOT}/${context.name}/${drive.path}`;
    }
    for (const owner of drives()) {
      const shortcut = owner.shortcuts.find((candidate) => candidate.target === driveId);
      const ownerPath = shortcut === undefined ? null : drivePath(owner.driveId);
      if (ownerPath !== null) return `${ownerPath}/${shortcut!.path}`;
    }
    return null;
  };

  const place = (segments: ReadonlyArray<string>, at: string | null): Place => {
    if (view === null)
      return segments.length === 0 ? { _tag: "virtual", entries: [] } : { _tag: "missing" };
    if (segments.length === 0) {
      return { _tag: "virtual", entries: view.contexts.map((context) => context.name) };
    }
    const context = view.contexts.find((candidate) => candidate.name === segments[0]);
    if (context === undefined) return { _tag: "missing" };
    const listed = context.drives.filter((drive) => drive.path !== null);
    const rest = segments.slice(1).join("/");
    const drive = listed.find((candidate) => isWithin(rest, candidate.path!));
    if (drive === undefined) {
      // A folder above drives: the context, or one of its groups.
      const children = [
        ...new Set(
          listed
            .filter((candidate) => rest === "" || candidate.path!.startsWith(`${rest}/`))
            .map(
              (candidate) =>
                candidate.path!.slice(rest === "" ? 0 : rest.length + 1).split("/")[0]!,
            ),
        ),
      ];
      return children.length === 0 ? { _tag: "missing" } : { _tag: "virtual", entries: children };
    }
    const inside = rest.slice(drive.path!.length + 1);
    // At another commit the drive reads as it was then, without today's shortcuts.
    const shortcut =
      at === null
        ? drive.shortcuts.find((candidate) => isWithin(inside, candidate.path))
        : undefined;
    if (shortcut === undefined) {
      return { _tag: "drive", drive, commit: at ?? drive.commit, path: inside };
    }
    const target = byId(shortcut.target);
    return target === null
      ? { _tag: "missing" }
      : {
          _tag: "drive",
          drive: target,
          commit: target.commit,
          path: inside.slice(shortcut.path.length + 1),
        };
  };

  /** A folder's listing at a commit: cached, least recently used out first. */
  const treeAt = (
    driveId: string,
    commit: string,
    path: string,
  ): Effect.Effect<TreeResult, ContextClientError> =>
    Effect.suspend(() => {
      const key = `${driveId}:${commit}:${path}`;
      const cached = trees.get(key);
      if (cached !== undefined) {
        trees.delete(key);
        trees.set(key, cached);
        return Effect.succeed(cached);
      }
      const running = fetching.get(key);
      if (running !== undefined) return Deferred.await(running);
      if (client === null) return Effect.succeed({ _tag: "missing" } as const);
      const done = Deferred.makeUnsafe<TreeResult, ContextClientError>();
      fetching.set(key, done);
      return client.tree({ driveId, commit, path }).pipe(
        Effect.tap((found) =>
          Effect.sync(() => {
            if (trees.size >= MAX_CACHED_TREES) trees.delete(trees.keys().next().value!);
            trees.set(key, found);
          }),
        ),
        Effect.onExit((exit) =>
          Effect.andThen(
            Effect.sync(() => fetching.delete(key)),
            Deferred.done(done, exit),
          ),
        ),
      );
    });

  const timeOf = (drive: ContextDrive) => drive.time ?? pinnedAt;

  const list = (path: string, at: string | null = null) =>
    Effect.gen(function* () {
      const segments = drivesSegments(path);
      if (segments === null) return null;
      const where = place(segments, at);
      switch (where._tag) {
        case "missing":
          return null;
        case "virtual":
          return where.entries.map((name): DrivesEntry => ({
            name,
            kind: "directory",
            size: 0,
            time: pinnedAt,
          }));
        case "drive": {
          if (where.commit === null) return where.path === "" ? [] : null;
          const found = yield* treeAt(where.drive.driveId, where.commit, where.path);
          if (found._tag !== "directory") return null;
          const time = timeOf(where.drive);
          const entries = found.entries.map((entry): DrivesEntry => ({
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            time,
          }));
          // A shortcut shows as the folder it replaced.
          const shortcuts = where.drive.shortcuts
            .filter((shortcut) => {
              const parent = shortcut.path.slice(0, Math.max(0, shortcut.path.lastIndexOf("/")));
              return parent === where.path && byId(shortcut.target) !== null;
            })
            .map((shortcut) => shortcut.path.slice(shortcut.path.lastIndexOf("/") + 1))
            .filter((name) => !entries.some((entry) => entry.name === name))
            .map((name): DrivesEntry => ({ name, kind: "directory", size: 0, time }));
          return [...entries, ...shortcuts];
        }
      }
    });

  const stat = (
    path: string,
    at: string | null = null,
  ): Effect.Effect<DrivesNode, ContextClientError> =>
    Effect.gen(function* () {
      const segments = drivesSegments(path);
      if (segments === null) return { _tag: "missing" } as const;
      const where = place(segments, at);
      switch (where._tag) {
        case "missing":
          return where;
        case "virtual":
          return { _tag: "directory", time: pinnedAt } as const;
        case "drive": {
          const time = timeOf(where.drive);
          if (where.path === "") return { _tag: "directory", time } as const;
          if (where.commit === null) return { _tag: "missing" } as const;
          // From its folder's listing, which `ls` or the last read already fetched.
          const cut = where.path.lastIndexOf("/");
          const parent = yield* treeAt(
            where.drive.driveId,
            where.commit,
            cut < 0 ? "" : where.path.slice(0, cut),
          );
          const name = where.path.slice(cut + 1);
          const found =
            parent._tag === "directory"
              ? parent.entries.find((entry) => entry.name === name)
              : undefined;
          if (found === undefined) return { _tag: "missing" } as const;
          if (found.kind === "directory") return { _tag: "directory", time } as const;
          return {
            _tag: "file",
            entry: { name: found.name, kind: found.kind, size: found.size, time },
            driveId: where.drive.driveId,
            oid: found.oid,
          } as const;
        }
      }
    });

  const blob = (driveId: string, oid: string) =>
    Effect.gen(function* () {
      const key = `${driveId}:${oid}`;
      const cached = blobs.get(key);
      if (cached !== undefined) {
        blobs.delete(key);
        blobs.set(key, cached);
        return { _tag: "blob", bytes: cached } as const;
      }
      if (client === null) return { _tag: "missing" } as const;
      const found = yield* client.blob({ driveId, oid });
      if (found._tag !== "blob") return found;
      blobs.set(key, found.bytes);
      blobBytes += found.bytes.length;
      for (const [oldest, bytes] of blobs) {
        if (blobBytes <= BLOB_CACHE_BYTES) break;
        blobs.delete(oldest);
        blobBytes -= bytes.length;
      }
      return found;
    });

  /** A file's bytes; `node` saves a lookup when the caller already has it. */
  const read = (path: string, at: string | null = null, node?: DrivesNode) =>
    Effect.gen(function* () {
      const known = node ?? (yield* stat(path, at));
      if (known._tag !== "file") return { _tag: known._tag } as DrivesRead;
      const found = yield* blob(known.driveId, known.oid);
      return found._tag === "blob"
        ? ({ _tag: "file", bytes: found.bytes } as const)
        : ({ _tag: found._tag } as const);
    });

  /**
   * The drive a `/drives` path reads from, following a shortcut to the drive
   * it points at; or a drive named by itself ("Billing") when only one has
   * that name.
   */
  const driveOf = (path: string): ContextDrive | null => {
    const segments = drivesSegments(path);
    if (segments === null || view === null) return null;
    const where = segments.length < 2 ? null : place(segments, null);
    if (where?._tag === "drive") return where.drive;
    const name = path.trim().toLowerCase();
    const named = drives().filter(
      (drive) => drive.path !== null && drive.path.split("/").at(-1)!.toLowerCase() === name,
    );
    return named.length === 1 ? named[0]! : null;
  };

  return {
    /**
     * Takes `nextClient`'s view: what every read sees until the next turn.
     * The client is this turn's either way. Answers whether the view changed.
     */
    pin: (nextClient: ContextClient) =>
      Effect.gen(function* () {
        client = nextClient;
        const next = yield* nextClient.view;
        const changed =
          view === null || contextJson.view.encode(view) !== contextJson.view.encode(next);
        view = next;
        pinnedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        return changed;
      }),
    current: () => view,
    client: () => client,
    drivePath,
    driveOf,
    list,
    stat,
    read,
    byId,
  };
};

export type DrivesView = ReturnType<typeof makeDrivesView>;
