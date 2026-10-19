import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerBuild,
  type ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { RunnerConnection, RunnerTransport } from "./RunnerSession.ts";
import { RunnerConnectionError } from "./RunnerConnectionError.ts";
import { makeRunnerExecHost, type RunnerExecWorkspaceAttestation } from "./RunnerExecHost.ts";

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

const protocolError = (message: string) => new RunnerConnectionError({ message });

const rejectConnection = (connection: RunnerConnection, reason: string) =>
  connection.send({ type: "end", reason }).pipe(Effect.andThen(Effect.fail(protocolError(reason))));

/** One command-only session. A lost socket ends this session; commands are never replayed. */
export const runRunnerCommandSession = Effect.fn("runRunnerCommandSession")(function* (
  input: RunnerCommandSessionInput,
): Effect.fn.Return<void, RunnerConnectionError> {
  yield* Effect.scoped(
    Effect.gen(function* () {
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
