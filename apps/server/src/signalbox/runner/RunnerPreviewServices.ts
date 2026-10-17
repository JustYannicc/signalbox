import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class PreviewServiceError extends Schema.TaggedError<PreviewServiceError>()(
  "PreviewServiceError",
  { message: Schema.String },
) {}

interface ActiveService {
  readonly service: PreviewService;
  readonly scope: Scope.Closeable;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
}

export interface RunnerPreviewServices {
  /** Starts this exact command for the declared port, replacing that port's prior command. */
  readonly start: (service: PreviewService) => Effect.Effect<void, PreviewServiceError>;
  /** Stops the command and removes its persisted declaration. */
  readonly stop: (port: number) => Effect.Effect<void>;
  /** Restores the thread's declarations on this Runner. */
  readonly restore: (
    services: ReadonlyArray<PreviewService>,
  ) => Effect.Effect<void, PreviewServiceError>;
  /** The declarations this Runner should report to the thread. */
  readonly list: Effect.Effect<ReadonlyArray<PreviewService>>;
}

const sameService = (left: PreviewService, right: PreviewService) =>
  left.port === right.port && left.command === right.command && left.cwd === right.cwd;

const within = (path: Path.Path, root: string, child: string) => {
  const relative = path.relative(root, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

/** Runs only commands an agent explicitly declared, scoped to its Runner and drive. */
export const makePreviewServices = Effect.fn("makePreviewServices")(function* (input: {
  /** The thread's checked-out drive. */
  readonly cwd: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const parentScope = yield* Effect.scope;
  const drive = yield* fs
    .realPath(input.cwd)
    .pipe(Effect.mapError(() => new PreviewServiceError({ message: "The drive is unavailable." })));
  const declarations = new Map<number, PreviewService>();
  const active = new Map<number, ActiveService>();
  const lock = yield* Semaphore.make(1);

  const serviceCwd = (service: PreviewService) =>
    Effect.gen(function* () {
      const resolved = path.resolve(drive, service.cwd);
      if (!within(path, drive, resolved)) {
        return yield* new PreviewServiceError({
          message: "The working directory must be inside the drive.",
        });
      }
      const real = yield* fs
        .realPath(resolved)
        .pipe(
          Effect.mapError(
            () => new PreviewServiceError({ message: "The working directory is unavailable." }),
          ),
        );
      if (!within(path, drive, real)) {
        return yield* new PreviewServiceError({
          message: "The working directory must be inside the drive.",
        });
      }
      const stat = yield* fs
        .stat(real)
        .pipe(
          Effect.mapError(
            () => new PreviewServiceError({ message: "The working directory is unavailable." }),
          ),
        );
      if (stat.type !== "Directory") {
        return yield* new PreviewServiceError({ message: "The working directory is unavailable." });
      }
      return real;
    });

  const stopProcess = (port: number) =>
    Effect.suspend(() => {
      const previous = active.get(port);
      if (previous === undefined) return Effect.void;
      active.delete(port);
      return Scope.close(previous.scope, Exit.void);
    });

  const startUnlocked = (service: PreviewService) =>
    Effect.gen(function* () {
      const cwd = yield* serviceCwd(service);
      const current = active.get(service.port);
      if (current !== undefined && sameService(current.service, service)) {
        const running = yield* current.process.isRunning.pipe(
          Effect.mapError(
            () =>
              new PreviewServiceError({
                message: `Could not inspect the service on port ${service.port}.`,
              }),
          ),
        );
        if (running) {
          declarations.set(service.port, service);
          return;
        }
      }
      yield* stopProcess(service.port);

      const scope = yield* Scope.fork(parentScope);
      const child = yield* Scope.provide(scope)(
        spawner.spawn(
          ChildProcess.make(service.command, [], {
            cwd,
            shell: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        ),
      ).pipe(
        Effect.mapError(
          () =>
            new PreviewServiceError({
              message: `Could not start the service on port ${service.port}.`,
            }),
        ),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const entry = { service, scope, process: child } satisfies ActiveService;
      active.set(service.port, entry);
      declarations.set(service.port, service);
      yield* child.exitCode.pipe(
        Effect.ignore,
        Effect.andThen(
          Scope.close(scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (active.get(service.port) === entry) active.delete(service.port);
              }),
            ),
          ),
        ),
        Effect.forkIn(parentScope),
      );
    });

  const start = (service: PreviewService) => lock.withPermits(1)(startUnlocked(service));
  const stop = (port: number) =>
    lock.withPermits(1)(
      Effect.sync(() => void declarations.delete(port)).pipe(Effect.andThen(stopProcess(port))),
    );
  const restore = (services: ReadonlyArray<PreviewService>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const wanted = new Map(services.map((service) => [service.port, service]));
        for (const port of declarations.keys()) {
          if (!wanted.has(port)) {
            declarations.delete(port);
            yield* stopProcess(port);
          }
        }
        for (const service of services.toSorted((a, b) => a.port - b.port)) {
          yield* startUnlocked(service);
        }
      }),
    );

  yield* Effect.addFinalizer(() => Effect.forEach(active.keys(), stopProcess, { discard: true }));

  return {
    start,
    stop,
    restore,
    list: Effect.sync(() => [...declarations.values()].toSorted((a, b) => a.port - b.port)),
  } satisfies RunnerPreviewServices;
});
