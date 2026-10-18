import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GitHub } from "../github/GitHub.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { HydrationRemoteError } from "./DriveHydration.ts";
import { DriveReadError, makeDriveReader, type RemoteFiles } from "./DriveReader.ts";
import { type Bytes, objectId, type Oid } from "./git/gitObjects.ts";

/**
 * A remote-backed drive's promised files (#406), from GitHub as the reader:
 * the drive's remote and the reader's `token` are asked for once, and only
 * when a file isn't cached. A file never changes, so it is kept in the colo's
 * cache by drive and id, where only readers of that drive look; `DriveReader`
 * checks every file against its id either way.
 */

/** No real host: the cache only needs a URL to key by. */
const cacheKey = (driveId: string, oid: Oid) =>
  `https://drive-files.signalbox.invalid/${encodeURIComponent(driveId)}/${oid}`;

/** The Workers cache, absent outside workerd (tests). */
const colo = (): Cache | null =>
  typeof caches === "undefined" ? null : ((caches as { readonly default?: Cache }).default ?? null);

/** A cache that fails is a cache that missed. */
const cached = (key: string) =>
  Effect.tryPromise(async () => {
    const response = await colo()?.match(key);
    return response === undefined ? null : new Uint8Array(await response.arrayBuffer());
  }).pipe(Effect.orElseSucceed(() => null));

const keep = (key: string, bytes: Bytes) =>
  Effect.tryPromise(async () => {
    await colo()?.put(
      key,
      new Response(bytes, { headers: { "cache-control": "public, max-age=31536000, immutable" } }),
    );
  }).pipe(Effect.ignore);

export const makeRemoteFiles = Effect.fn("makeRemoteFiles")(function* <E>(
  driveId: string,
  token: Effect.Effect<string | null, E>,
) {
  const github = yield* GitHub;
  const directory = yield* DriveDirectory;
  const fail = (message: string) => new DriveReadError({ message });
  const repository = yield* Effect.cached(
    directory
      .forDrive(driveId)
      .remote()
      .pipe(
        Effect.map((remote) => remote?.repository ?? null),
        Effect.mapError(() => fail("The drive can't be read right now.")),
      ),
  );
  const userToken = yield* Effect.cached(
    token.pipe(Effect.mapError(() => fail("GitHub can't be reached right now."))),
  );
  return {
    range: ({ repository: frozenRepository, oid, offset, length, knownSize }) =>
      Effect.gen(function* () {
        if ((yield* repository) !== frozenRepository) {
          return yield* fail("The drive's remote source has changed.");
        }
        const bearer = yield* userToken;
        if (bearer === null) return yield* fail("Connect GitHub to read this file.");
        const page = yield* github.api
          .blobRange(bearer, frozenRepository, oid, offset, length)
          .pipe(
            Effect.mapError(
              (cause) =>
                new DriveReadError({
                  message: "GitHub did not send the requested file range.",
                  cause,
                }),
            ),
          );
        if (page === null) return null;
        const size =
          page.size ??
          knownSize ??
          (yield* github.api.blobSize(bearer, frozenRepository, oid).pipe(
            Effect.mapError(
              (cause) =>
                new DriveReadError({
                  message: "GitHub did not identify the file's size.",
                  cause,
                }),
            ),
          ));
        if (size === null) return yield* fail("GitHub did not identify the file's size.");
        return {
          bytes: page.bytes,
          totalSize: size,
          complete: offset + page.bytes.length === size,
        };
      }).pipe(Effect.mapError((cause) => new HydrationRemoteError({ oid, cause }))),
    blob: (oid) =>
      Effect.gen(function* () {
        const key = cacheKey(driveId, oid);
        const hit = yield* cached(key);
        if (hit !== null) return hit;
        const remote = yield* repository;
        if (remote === null) return null;
        const bearer = yield* userToken;
        if (bearer === null) {
          return yield* fail(`Connect GitHub to read this file: it's kept on ${remote}.`);
        }
        const bytes = yield* github.api
          .blob(bearer, remote, oid)
          .pipe(Effect.mapError((error) => fail(`GitHub didn't send the file: ${error.message}`)));
        // Only a file that is what it claims to be is kept for others.
        if (bytes !== null && (yield* Effect.promise(() => objectId("blob", bytes))) === oid) {
          yield* keep(key, bytes);
        }
        return bytes;
      }),
  } satisfies RemoteFiles;
});

/**
 * `driveId`'s reader, reading promised files from GitHub with `token` when
 * GitHub is available here (it is in the cloud; tests may leave it out).
 */
export const remoteDriveReader = <E>(driveId: string, token: Effect.Effect<string | null, E>) =>
  Effect.gen(function* () {
    const github = yield* Effect.serviceOption(GitHub);
    const remote = Option.isNone(github)
      ? undefined
      : yield* makeRemoteFiles(driveId, token).pipe(Effect.provideService(GitHub, github.value));
    return yield* makeDriveReader(driveId, remote);
  });
