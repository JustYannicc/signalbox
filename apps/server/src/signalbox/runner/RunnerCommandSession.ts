import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerBuild,
  type ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { MachineFilesResult } from "@signalbox/runner-protocol/MachineFilesProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { RunnerConnection, RunnerTransport } from "./RunnerSession.ts";
import { RunnerConnectionError } from "./RunnerConnectionError.ts";
import { makeRunnerExecHost, type RunnerExecWorkspaceAttestation } from "./RunnerExecHost.ts";
import * as RunnerMachineFiles from "./RunnerMachineFiles.ts";

export interface RunnerCommandSessionInput {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly token: string;
  readonly machineId: string;
  readonly imageVersion: string;
  readonly build: RunnerBuild;
  readonly transport: RunnerTransport;
  /** Supplied by the caller that owns the actual canonical workspace mount. */
  readonly workspace: RunnerExecWorkspaceAttestation;
}

const rejectConnection = (connection: RunnerConnection, reason: string) =>
  connection
    .send({ type: "end", reason })
    .pipe(Effect.andThen(Effect.fail(new RunnerConnectionError({ message: reason }))));

/** One command-only session. A lost socket ends this session; commands are never replayed. */
export const runRunnerCommandSession = Effect.fn("runRunnerCommandSession")(function* (
  input: RunnerCommandSessionInput,
): Effect.fn.Return<void, RunnerConnectionError, RunnerMachineFiles.RunnerMachineFiles> {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const machineFiles = yield* RunnerMachineFiles.RunnerMachineFiles;
      const connection = yield* input.transport.connect;

      yield* connection.send({
        type: "hello",
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        imageVersion: input.imageVersion,
        machineId: input.machineId,
        threadId: input.threadId,
        generation: input.generation,
        token: input.token,
        lastAckedSequence: 0,
        build: input.build,
        exec: true,
        machineFileLookup: true,
      });

      const firstMessage = yield* connection.receive;
      if (firstMessage.type === "refused" || firstMessage.type === "end") return;
      if (firstMessage.type !== "welcome") {
        return yield* rejectConnection(connection, "The command-only Runner expected a welcome.");
      }
      if (
        firstMessage.generation !== input.generation ||
        firstMessage.ackedSequence !== 0 ||
        firstMessage.activeRunId !== null
      ) {
        return yield* rejectConnection(
          connection,
          "The command-only Runner received an incompatible welcome.",
        );
      }

      const host = yield* makeRunnerExecHost({
        threadId: input.threadId,
        generation: input.generation,
        workspace: input.workspace,
      });
      // A report-send failure must interrupt the receive loop, even when the peer sends nothing.
      const sessionFailure = yield* Deferred.make<RunnerConnectionError>();
      yield* Stream.runForEach(host.reports, (report) =>
        connection.send({ type: "exec.report", report }),
      ).pipe(
        Effect.catchCause((cause) =>
          Deferred.succeed(
            sessionFailure,
            new RunnerConnectionError({ message: "Failed to send an exec report.", cause }),
          ),
        ),
        Effect.forkScoped,
      );

      const nextMessage = Effect.raceFirst(
        connection.receive,
        Deferred.await(sessionFailure).pipe(Effect.flatMap(Effect.fail)),
      );

      while (true) {
        const message: ThreadMessage = yield* nextMessage;
        switch (message.type) {
          case "end":
            return;
          case "exec.command":
            if (message.command.generation !== input.generation) {
              return yield* rejectConnection(
                connection,
                "The command-only Runner received a stale generation command.",
              );
            }
            // Reserve receipts in frame order, but don't let a pending stdin
            // write keep later cancellation commands from reaching the host.
            yield* host.handleCommand(message).pipe(
              Effect.catchCause((cause) =>
                Deferred.succeed(
                  sessionFailure,
                  new RunnerConnectionError({ message: "Failed to apply an exec command.", cause }),
                ),
              ),
              Effect.forkScoped({ startImmediately: true }),
              Effect.asVoid,
            );
            break;
          case "machine.files.request":
            if (message.generation !== input.generation) {
              const result: MachineFilesResult = {
                type: "machine.files.result",
                generation: message.generation,
                requestId: message.requestId,
                outcome: {
                  status: "error",
                  code: "stale_generation",
                  message: "This Runner generation is stale.",
                },
              };
              yield* connection.send(result);
              break;
            }
            yield* machineFiles.lookup(message).pipe(
              Effect.catchTags({
                RunnerMachineFilesError: () =>
                  Effect.succeed(RunnerMachineFiles.lookupFailedResult(message)),
              }),
              Effect.flatMap((result) => connection.send(result)),
              Effect.catchCause((cause) =>
                Deferred.succeed(
                  sessionFailure,
                  new RunnerConnectionError({
                    message: "Failed to answer a machine file lookup.",
                    cause,
                  }),
                ),
              ),
              Effect.forkScoped({ startImmediately: true }),
              Effect.asVoid,
            );
            break;
          default:
            return yield* rejectConnection(
              connection,
              "The command-only Runner received an unsupported message.",
            );
        }
      }
    }),
  );
});
