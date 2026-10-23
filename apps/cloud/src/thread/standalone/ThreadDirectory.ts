import { RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as ThreadAccess from "../ThreadAccess.ts";
import * as ThreadDirectory from "../ThreadDirectory.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadPulls from "../ThreadPulls.ts";
import * as ThreadRunner from "../runner/ThreadRunner.ts";
import * as ThreadStore from "../ThreadStore.ts";
import { commandThreadId } from "../threadDecider.ts";

const isThreadNotFound = Schema.is(ThreadAccess.ThreadNotFoundError);

const unsupported = (operation: string) =>
  new ThreadAccess.ThreadObjectError({
    operation,
    cause: new Error("This standalone Thread runtime does not provide that capability."),
  });

const failure = <A>(operation: string): Effect.Effect<A, ThreadAccess.ThreadObjectError> =>
  Effect.fail(unsupported(operation));

const failureStream = <A>(operation: string): Stream.Stream<A, ThreadAccess.ThreadObjectError> =>
  Stream.fail(unsupported(operation));

const lifecycle = ({ trashId, deletedAt, purgeAfter, state }: ThreadStore.ThreadTrashReceipt) => ({
  trashId,
  deletedAt,
  purgeAfter,
  state,
});

export const layerStandaloneThreadDirectory = (threadId: ThreadId) =>
  Layer.effect(
    ThreadDirectory.ThreadDirectory,
    Effect.gen(function* () {
      const engine = yield* ThreadEngine.ThreadEngine;
      const runner = yield* ThreadRunner.ThreadRunner;
      const pulls = yield* ThreadPulls.ThreadPulls;

      const onThread = <A, E>(
        requested: ThreadId,
        run: () => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | ThreadAccess.ThreadNotFoundError> =>
        requested === threadId
          ? Effect.suspend(run)
          : Effect.fail(new ThreadAccess.ThreadNotFoundError());

      const onThreadStream = <A, E>(
        requested: ThreadId,
        operation: string,
        run: () => Effect.Effect<Stream.Stream<A>, E>,
      ): Stream.Stream<A, ThreadAccess.ThreadNotFoundError | ThreadAccess.ThreadObjectError> =>
        requested === threadId
          ? Stream.unwrap(run()).pipe(
              Stream.mapError((cause) =>
                isThreadNotFound(cause)
                  ? cause
                  : new ThreadAccess.ThreadObjectError({ operation, cause }),
              ),
            )
          : Stream.fail(new ThreadAccess.ThreadNotFoundError());

      const objectError = <A, E>(
        requested: ThreadId,
        operation: string,
        run: () => Effect.Effect<A, E>,
      ): Effect.Effect<A, E | ThreadAccess.ThreadObjectError> =>
        requested === threadId ? Effect.suspend(run) : failure(operation);

      const handleFor = (requested: ThreadId): ThreadDirectory.ThreadHandle => ({
        terminalOpen: () => failure("terminal.open"),
        terminalWrite: () => failure("terminal.write"),
        terminalClose: () => failure("terminal.close"),
        terminalResize: () => failure("terminal.resize"),
        terminalClear: () => failure("terminal.clear"),
        terminalRestart: () => failure("terminal.restart"),
        terminalAttach: () => failureStream("terminal.attach"),
        uploadFeedback: () => failure("feedback.upload"),
        trash: (actor, input) =>
          onThread(requested, () => Effect.map(engine.trash(actor, input), lifecycle)),
        restore: (actor, input) =>
          onThread(requested, () =>
            Effect.map(engine.restoreTrash(actor, input.trashId), lifecycle),
          ),
        purge: (actor, input) => onThread(requested, () => engine.purgeTrash(actor, input)),
        getWorkflowScript: (actor, input) =>
          onThread(requested, () => engine.getWorkflowScript(actor, input)),
        stopWorkflow: (actor, input) =>
          onThread(requested, () => engine.stopWorkflow(actor, input)),
        answerSecret: () => failure("secret.answer"),
        dispatch: (actor, command, creation) =>
          commandThreadId(command) !== requested
            ? Effect.fail(new ThreadAccess.ThreadNotFoundError())
            : onThread(requested, () => engine.dispatch(actor, command, creation)),
        launch: (actor, input, creation) =>
          input.threadId !== requested
            ? Effect.fail(new ThreadAccess.ThreadNotFoundError())
            : onThread(requested, () => engine.launch(actor, input, creation)),
        subscribePreparation: (actor) =>
          onThreadStream(requested, "subscribePreparation", () =>
            engine.subscribePreparation(actor),
          ),
        cancelPreparation: (actor, input) =>
          onThread(requested, () =>
            engine.cancelPreparation(actor, input).pipe(
              Effect.catchTags({
                WorktreeSetupError: (error) =>
                  Effect.fail(
                    ThreadAccess.ThreadCommandRejectedError.forCommand(
                      {
                        id: `preparation:${input.runId}:${input.preparationGeneration}`,
                        type: "worktreeSetup.cancel",
                      },
                      error.message,
                    ),
                  ),
              }),
            ),
          ),
        snapshot: (actor) => onThread(requested, () => engine.snapshot(actor)),
        workspace: (actor) => onThread(requested, () => engine.workspace(actor)),
        subscribe: (actor, input) =>
          onThreadStream(requested, "subscribe", () => engine.subscribe(actor, input)),
        summary: (actor) => objectError(requested, "summary", () => engine.summary(actor)),
        backfill: (actor, requestKey) =>
          onThread(requested, () =>
            engine
              .backfill(actor, requestKey)
              .pipe(
                Effect.flatMap((progress) =>
                  progress === null
                    ? Effect.fail(new ThreadAccess.ThreadNotFoundError())
                    : Effect.succeed(progress),
                ),
              ),
          ),
        searchDocuments: (actor, itemIds) =>
          objectError(requested, "searchDocuments", () => engine.searchDocuments(actor, itemIds)),
        find: (actor, input) => onThread(requested, () => engine.find(actor, input)),
        authorizeExecutorTurn: (actor, input) =>
          objectError(requested, "authorizeExecutorTurn", () =>
            engine.summary(actor).pipe(
              Effect.flatMap((summary) =>
                summary === null
                  ? Effect.succeed(false)
                  : runner.authorizeExecutorTurn({
                      runId: RunId.make(input.runId),
                      generation: input.generation,
                    }),
              ),
            ),
          ),
        commandOutput: (actor, input) =>
          onThreadStream(requested, "commandOutput", () => engine.commandOutput(actor, input)),
        requestPullRequestSync: () => failure("pullRequest.sync"),
        diagnostics: () => failure("diagnostics.read"),
        previews: () => failureStream("preview.subscribe"),
        previewLink: () => failure("preview.link"),
        browserWatch: () => failureStream("browser.watch"),
        browserInput: () => failure("browser.input"),
        browserTrail: () => failure("browser.trail"),
        browserStep: () => failure("browser.step"),
        contextMatch: () => failure("context.match"),
        contextTurns: () => failure("context.turns"),
        setMonitors: (actor, monitors) =>
          onThread(requested, () => engine.setMonitors(actor, monitors)).pipe(
            Effect.catchTags({ ThreadNotFoundError: () => Effect.void }),
          ),
        browsing: () => failureStream("browsing.subscribe"),
        browse: () => failure("browsing.dispatch"),
        browsingRecord: () => failure("browsing.record"),
        pullOwner: (actor, driveId) =>
          objectError(requested, "pullOwner", () => pulls.owner(actor, driveId)).pipe(
            Effect.mapError(
              (cause) => new ThreadAccess.ThreadObjectError({ operation: "pullOwner", cause }),
            ),
          ),
        pullTarget: (actor, driveId, operationId, branch) =>
          objectError(requested, "pullTarget", () =>
            pulls.target(actor, driveId, operationId, branch),
          ).pipe(
            Effect.mapError(
              (cause) => new ThreadAccess.ThreadObjectError({ operation: "pullTarget", cause }),
            ),
          ),
        reservePublication: (actor, driveId, operationId) =>
          onThread(requested, () => pulls.reservePublication(actor, driveId, operationId)),
        releasePublication: (actor, driveId, operationId) =>
          objectError(requested, "releasePublication", () =>
            pulls.releasePublication(actor, driveId, operationId),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadAccess.ThreadObjectError({ operation: "releasePublication", cause }),
            ),
          ),
        pull: (actor, input) =>
          onThread(requested, () =>
            Effect.flatMap(pulls.begin(actor, input), () => pulls.wait(actor, input.operationId)),
          ),
      });

      return ThreadDirectory.ThreadDirectory.of({ forThread: handleFor });
    }),
  );
