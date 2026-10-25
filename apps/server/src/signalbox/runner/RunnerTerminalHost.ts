import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../../processRunner.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import { makeRunnerDrive, type RunnerDrive } from "./RunnerDrive.ts";
import { RunnerConnectionError } from "./RunnerConnectionError.ts";
import type { RunnerSessionInput } from "./RunnerSession.ts";
import { makeRunnerTerminals } from "./RunnerTerminals.ts";

export const makeRunnerTerminalHost = Effect.fn("makeRunnerTerminalHost")(function* (input: {
  readonly threadId: string;
  readonly leaseGeneration: number;
  readonly cwd: string;
  readonly logsDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly preparing: Semaphore.Semaphore;
  readonly filesPrepared: () => boolean;
  readonly openDrive: (
    access: DriveAccess,
  ) => Effect.Effect<RunnerDrive, Effect.Error<ReturnType<typeof makeRunnerDrive>>>;
  readonly prepareDependencies: Effect.Effect<unknown>;
}) {
  const prepareDrive = (access: DriveAccess) =>
    input.preparing
      .withPermits(1)(
        Effect.gen(function* () {
          const drive = yield* input.openDrive(access);
          // A terminal joins the live workspace without restoring over an active turn.
          if (input.filesPrepared()) return drive;
          yield* drive.prepare(access.remoteToken, access.author, access.instructions);
          yield* input.prepareDependencies;
          yield* drive.restoreDependencyEdits;
          return drive;
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new RunnerConnectionError({
              message: "Could not restore the terminal's files.",
              cause,
            }),
        ),
      );
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir: input.logsDir,
    ptyAdapter: yield* NodePtyAdapter.make(),
    env: input.environment,
  }).pipe(Effect.provide(ProcessRunner.layer));

  return ((emit, watchDrive) =>
    makeRunnerTerminals({
      threadId: input.threadId,
      leaseGeneration: input.leaseGeneration,
      cwd: input.cwd,
      manager,
      prepareDrive,
      watchDrive,
      emit,
    })) satisfies RunnerSessionInput["makeTerminals"];
});
