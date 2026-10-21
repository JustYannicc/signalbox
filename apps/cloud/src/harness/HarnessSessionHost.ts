import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { HarnessError } from "./Harness.ts";
import { loadHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessHostOptions, HarnessSessionHost } from "./host/contracts.ts";
import { createHostLifecycle } from "./host/lifecycle.ts";
import { createSeedCatalog } from "./host/seed.ts";

export type {
  ExecutorMcpPort,
  ExecutorTarget,
  HarnessHostFilesOptions,
  HarnessHostOptions,
  HarnessHostSession,
  HarnessSessionHost,
  HostOpenInput,
  NativeHostBinding,
  NativeMcpConfiguration,
  NativeThreadLoad,
  ProgramSeed,
  ResolvedConnections,
  SeedStage,
  TurnAccess,
} from "./host/contracts.ts";

/**
 * The caller owns exclusive startup/seeding and ends prior ownership before supplying a new
 * attempt. These injected ports establish no Thread lease or production grant authority.
 * A committed attempt is never replayed after a crash, even when native startup is unknown.
 */
export const createHarnessSessionHost = <G>(
  supplied: HarnessHostOptions<G>,
): Effect.Effect<HarnessSessionHost<G>, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const options = {
      ...supplied,
      files: {
        ...supplied.files,
        rootMetadata: { ...supplied.files.rootMetadata },
        posix: {
          ...supplied.files.posix,
          credentials: {
            ...supplied.files.posix.credentials,
            ...(supplied.files.posix.credentials.groups === undefined
              ? {}
              : { groups: [...supplied.files.posix.credentials.groups] }),
          },
        },
      },
      release: {
        ...supplied.release,
        identity: { ...supplied.release.identity },
        trustedComputer: { ...supplied.release.trustedComputer },
      },
      programs: {
        ...supplied.programs,
        files: Object.fromEntries(
          Object.entries(supplied.programs.files).map(([path, file]) => [path, { ...file }]),
        ),
      },
    };
    const loaded = yield* Effect.tryPromise({
      try: () => loadHarnessRelease(options.release),
      catch: () =>
        new HarnessError({
          operation: "open",
          message: "Harness release could not be verified.",
        }),
    });
    const catalog = yield* Effect.tryPromise({
      try: () =>
        createSeedCatalog(loaded, options.programs, options.files, {
          artifact: options.release.identity,
          computer: loaded.plan.computer,
          thread: options.threadId,
          filesystem: options.files.identity,
        }),
      catch: () =>
        new HarnessError({
          operation: "open",
          message: "Harness seed catalog is invalid.",
        }),
    });
    const { release: _release, programs: _programs, ...hostOptions } = options;
    // Release sources may close over entire bundles; the live host only needs verified assets.
    return yield* createHostLifecycle(hostOptions, loaded, catalog);
  });
