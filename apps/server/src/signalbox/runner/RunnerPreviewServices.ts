import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import * as Context from "effect/Context";
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
  {
    operation: Schema.Literals([
      "prepare_drive",
      "resolve_directory",
      "inspect_directory",
      "inspect_process",
      "start_process",
    ]),
    port: Schema.optional(Schema.Number),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface ActiveService {
  readonly service: PreviewService;
  readonly scope: Scope.Closeable;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
}

export class RunnerPreviewServices extends Context.Service<
  RunnerPreviewServices,
  {
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
>()("t3/signalbox/runner/RunnerPreviewServices") {}

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
  /** The filtered Runner tool environment, read on each start so current folder secrets apply. */
  readonly environment: () => NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const parentScope = yield* Effect.scope;
  const drive = yield* fs.realPath(input.cwd).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewServiceError({
          operation: "prepare_drive",
          message: "The drive is unavailable.",
          cause,
        }),
    ),
  );
  const declarations = new Map<number, PreviewService>();
  const active = new Map<number, ActiveService>();
  const lock = yield* Semaphore.make(1);

  const serviceCwd = (service: PreviewService) =>
    Effect.gen(function* () {
      const resolved = path.resolve(drive, service.cwd);
      if (!within(path, drive, resolved)) {
        return yield* new PreviewServiceError({
          operation: "resolve_directory",
          port: service.port,
          message: "The working directory must be inside the drive.",
        });
      }
      const real = yield* fs.realPath(resolved).pipe(
        Effect.mapError(
          (cause) =>
            new PreviewServiceError({
              operation: "resolve_directory",
              port: service.port,
              message: "The working directory is unavailable.",
              cause,
            }),
        ),
      );
      if (!within(path, drive, real)) {
        return yield* new PreviewServiceError({
          operation: "resolve_directory",
          port: service.port,
          message: "The working directory must be inside the drive.",
        });
      }
      const stat = yield* fs.stat(real).pipe(
        Effect.mapError(
          (cause) =>
            new PreviewServiceError({
              operation: "inspect_directory",
              port: service.port,
              message: "The working directory is unavailable.",
              cause,
            }),
        ),
      );
      if (stat.type !== "Directory") {
        return yield* new PreviewServiceError({
          operation: "inspect_directory",
          port: service.port,
          message: "The working directory is unavailable.",
        });
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
            (cause) =>
              new PreviewServiceError({
                operation: "inspect_process",
                port: service.port,
                message: `Could not inspect the service on port ${service.port}.`,
                cause,
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
            env: { ...input.environment(), PWD: cwd },
            shell: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PreviewServiceError({
              operation: "start_process",
              port: service.port,
              message: `Could not start the service on port ${service.port}.`,
              cause,
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
  } satisfies RunnerPreviewServices["Service"];
});
