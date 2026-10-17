import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const LockOwner = Schema.Struct({ pid: Schema.Number, startTime: Schema.String });
const encodeLockOwner = Schema.encodeSync(Schema.fromJsonString(LockOwner));
const decodeLockOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(LockOwner));

export type ProcessIdentity = typeof LockOwner.Type;
export type ProcessObservation =
  | { readonly _tag: "dead" }
  | { readonly _tag: "alive"; readonly startTime: string }
  | { readonly _tag: "unknown" };

export interface ProcessIdentityProbe<E = never, R = never> {
  readonly current: Effect.Effect<ProcessIdentity, E, R>;
  readonly observe: (pid: number) => Effect.Effect<ProcessObservation, E, R>;
}

export class NativeArtifactLockError extends Schema.TaggedError<NativeArtifactLockError>()(
  "NativeArtifactLockError",
  { message: Schema.String },
) {}

export interface NativeArtifactLockOptions<E = never, R = never> {
  readonly lockPath: string;
  readonly process: ProcessIdentityProbe<E, R>;
  readonly acquisitionTimeoutMs?: number;
  readonly wait?: () => Effect.Effect<void, E, R>;
}

export const DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS = 30 * 60 * 1_000;

const formatTimeout = (timeoutMs: number) =>
  timeoutMs % 60_000 === 0
    ? `${timeoutMs / 60_000} minutes`
    : timeoutMs % 1_000 === 0
      ? `${timeoutMs / 1_000} seconds`
      : `${timeoutMs} milliseconds`;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("reason" in error)) return undefined;
  const cause = error.reason;
  if (typeof cause !== "object" || cause === null || !("cause" in cause)) return undefined;
  const nested = cause.cause;
  return typeof nested === "object" && nested !== null && "code" in nested
    ? String(nested.code)
    : undefined;
};

type OwnerRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "owner"; readonly owner: ProcessIdentity };

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const readOwner = (
  lockPath: string,
): Effect.Effect<OwnerRead, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs
      .readFileString(path.join(lockPath, "owner.json"))
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null)));
    if (text === null) return { _tag: "missing" };
    const owner = yield* decodeLockOwner(text).pipe(Effect.result);
    return owner._tag === "Success" ? { _tag: "owner", owner: owner.success } : { _tag: "invalid" };
  });

const sameOwner = (left: ProcessIdentity | null, right: ProcessIdentity) =>
  left !== null && left.pid === right.pid && left.startTime === right.startTime;

const provenDead = (owner: ProcessIdentity, observation: ProcessObservation): boolean =>
  observation._tag === "dead" ||
  (observation._tag === "alive" && observation.startTime !== owner.startTime);

const tryCreateDirectory = (lockPath: string, owner: ProcessIdentity) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const created = yield* fs.makeDirectory(lockPath).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => errorCode(error) === "EEXIST",
        () => Effect.succeed(false),
      ),
    );
    if (!created) return false;

    const ownerPath = path.join(lockPath, "owner.json");
    yield* fs.writeFileString(ownerPath, encodeLockOwner(owner)).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? fs.remove(lockPath, { recursive: true, force: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.uninterruptible,
    );
    return true;
  });

const releaseDirectory = (lockPath: string, owner: ProcessIdentity) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* readOwner(lockPath);
    if (current._tag === "owner" && sameOwner(current.owner, owner)) {
      yield* fs.remove(lockPath, { recursive: true, force: true });
    }
  });

const wait = <E, R>(options: NativeArtifactLockOptions<E, R>) =>
  options.wait?.() ?? Effect.sleep("200 millis");

const withDirectoryLock = <A, E, R, EProcess, RProcess>(
  lockPath: string,
  options: NativeArtifactLockOptions<EProcess, RProcess>,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | EProcess | NativeArtifactLockError | PlatformError.PlatformError,
  R | RProcess | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* acquireDirectoryLock(lockPath, options);
      return yield* use;
    }),
  );

const reclaimStaleDirectory = <E, R>(
  lockPath: string,
  expected: ProcessIdentity,
  options: NativeArtifactLockOptions<E, R>,
) =>
  withDirectoryLock(
    `${lockPath}.reaper`,
    options,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const current = yield* readOwner(lockPath);
      if (current._tag !== "owner" || !sameOwner(current.owner, expected)) return;
      const observation = yield* options.process.observe(expected.pid);
      if (provenDead(expected, observation)) {
        yield* fs.remove(lockPath, { recursive: true, force: true });
      }
    }),
  );

const acquireDirectoryLock = <E, R>(lockPath: string, options: NativeArtifactLockOptions<E, R>) => {
  const acquire = Effect.gen(function* () {
    const owner = yield* options.process.current;

    while (true) {
      const claimed = yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          if (!(yield* tryCreateDirectory(lockPath, owner))) return false;
          yield* Effect.addFinalizer(() => releaseDirectory(lockPath, owner).pipe(Effect.ignore));
          return true;
        }),
      );
      if (claimed) return;

      const existing = yield* readOwner(lockPath);
      if (existing._tag === "missing") {
        // A creator writes metadata before leaving its masked claim section. Never guess ownership.
        yield* wait(options);
        continue;
      }
      if (existing._tag === "invalid") {
        return yield* new NativeArtifactLockError({
          message: `Lock owner metadata is invalid at ${lockPath}; refusing to reclaim it.`,
        });
      }

      const observation = yield* options.process.observe(existing.owner.pid);
      if (observation._tag === "unknown") {
        return yield* new NativeArtifactLockError({
          message: `Could not verify lock owner ${existing.owner.pid} at ${lockPath}; refusing to reclaim it.`,
        });
      }
      if (!provenDead(existing.owner, observation)) {
        yield* wait(options);
        continue;
      }

      yield* reclaimStaleDirectory(lockPath, existing.owner, options);
    }
  });

  const timeoutMs = options.acquisitionTimeoutMs ?? DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS;
  return acquire.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new NativeArtifactLockError({
            message: `Timed out after ${formatTimeout(timeoutMs)} waiting for native artifact lock at ${lockPath}.`,
          }),
        ),
    }),
  );
};

export const withNativeArtifactLock = <A, E, R, EProcess, RProcess>(
  options: NativeArtifactLockOptions<EProcess, RProcess>,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | EProcess | NativeArtifactLockError | PlatformError.PlatformError,
  R | RProcess | FileSystem.FileSystem | Path.Path
> => withDirectoryLock(options.lockPath, options, use);
