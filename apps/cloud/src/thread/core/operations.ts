import { clientAskCommand } from "@t3tools/shared/signalboxAsks";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { traceSynchronization } from "@t3tools/shared/synchronization";
import {
  CommandId,
  type ChatAttachment,
  OrchestrationV2CommandOutputError,
  type OrchestrationV2ThreadStreamItem,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ThreadCommand } from "../threadCommands.ts";
import { dispatchAutomationAskAnswer } from "../../automations/askAnswers.ts";

import { CloudAttachments } from "../../attachments/CloudAttachments.ts";
import { remoteThreadWorktree } from "../../user/contextProjects.ts";
import {
  ThreadContexts,
  type ThreadFolderTrashedError,
  type ThreadPlace,
  type ThreadTurn,
} from "../../user/threadContexts.ts";
import { commandThreadId, unsupported } from "../threadDecider.ts";
import * as ThreadDirectory from "../ThreadDirectory.ts";
import { ThreadKindTurns, withLevel } from "../ThreadKindTurns.ts";
import { STATUS_LINE_INSTRUCTIONS } from "../statusLine/statusInstructions.ts";
import { type Actor, ThreadCommandRejectedError, ThreadNotFoundError } from "../ThreadAccess.ts";
import type { ThreadCreation } from "../ThreadEngine.ts";
import * as Threads from "../Threads.ts";
import { resuming } from "./resuming.ts";
import { makeWorkspaceRefresh } from "./remoteWorkspace.ts";

type Batch = ReadonlyArray<OrchestrationV2ThreadStreamItem>;

/** The highest sequence a batch brings the client to, if it moves the cursor at all. */
const cursorAfter = (batch: Batch): number | undefined => {
  let cursor: number | undefined;
  for (const item of batch) {
    if (item.kind === "snapshot") cursor = item.snapshotSequence;
    if (item.kind === "event" || item.kind === "unknown-event") cursor = item.sequence;
  }
  return cursor;
};

/**
 * A new thread's place, its own branch when its drive is backed by a remote
 * (#135), and what its turn runs on and follows.
 */
const placed = (
  place: ThreadPlace | null,
  threadId: ThreadId,
  turn: ThreadTurn | null,
): ThreadCreation => ({
  place: place === null ? null : { contextId: place.contextId, driveId: place.driveId },
  worktree: place?.remote === true ? remoteThreadWorktree(place.driveId, threadId) : null,
  pools: turn?.pools ?? null,
  ...(turn === null ? {} : { instructions: turn.instructions, secrets: turn.secrets }),
});

/**
 * Runs `send` with `attachments` claimed into `threadId` (`CloudAttachments.claim`).
 * A thread that refuses the message never holds the copies, so they go again; after
 * any other failure the message may have landed, so they stay.
 */
const withClaimed = <A, E>(
  claims: CloudAttachments["Service"],
  input: {
    readonly actor: Actor;
    readonly threadId: ThreadId;
    readonly command: { readonly id: string; readonly type: string };
    readonly attachments: ReadonlyArray<ChatAttachment>;
  },
  send: (claimed: ReadonlyArray<ChatAttachment>) => Effect.Effect<A, E>,
) =>
  input.attachments.length === 0
    ? send(input.attachments)
    : claims
        .claim({
          userId: input.actor.userId,
          threadId: input.threadId,
          commandId: input.command.id,
          attachments: input.attachments,
        })
        .pipe(
          Effect.mapError((error) =>
            ThreadCommandRejectedError.forCommand(input.command, error.reason),
          ),
          Effect.flatMap((claimed) =>
            send(claimed.attachments).pipe(
              Effect.tapError((error) => (isRefusal(error) ? claimed.release : Effect.void)),
            ),
          ),
        );

const isRejected = Schema.is(ThreadCommandRejectedError);
const isNotFound = Schema.is(ThreadNotFoundError);
const isRefusal = (error: unknown) => isRejected(error) || isNotFound(error);

/** Commands that can start a turn or pick a model: they carry the resolved pools, instructions and secrets. */
const PICKS_A_POOL: ReadonlySet<ThreadCommand["type"]> = new Set([
  "thread.create",
  "message.dispatch",
  "thread.ask.answer",
  "runtime-request.respond",
  "thread.model-selection.set",
]);

/** What a command sends, for the thread's kind (`ThreadKindTurns`). */
const messageOf = (command: ThreadCommand) =>
  command.type === "message.dispatch" ? { text: command.text, title: command.titleSeed } : null;

const rejectTrashedFolder = <A>(
  effect: Effect.Effect<A, ThreadFolderTrashedError>,
  command: { readonly id: string; readonly type: string },
) =>
  effect.pipe(
    Effect.mapError((error) => ThreadCommandRejectedError.forCommand(command, error.message)),
  );

export const makeThreads = Effect.gen(function* () {
  const directory = yield* ThreadDirectory.ThreadDirectory;
  const crypto = yield* Crypto.Crypto;
  const threadContexts = yield* ThreadContexts;
  const attachments = yield* CloudAttachments;
  const kindTurns = yield* ThreadKindTurns;

  const refreshWorkspace = makeWorkspaceRefresh({ directory, threadContexts, crypto });

  const refreshRemoteWorkspace: Threads.Threads["Service"]["refreshRemoteWorkspace"] = (
    actor,
    threadId,
  ) => Effect.asVoid(refreshWorkspace(actor, threadId));

  /** The thread's turn from its home's chain, with its kind's level and the status line's last on it. */
  const turnOf = (
    threadId: ThreadId,
    projectId: ProjectId | null,
    message: Parameters<ThreadKindTurns["Service"]["beforeTurn"]>[1],
    command: { readonly id: string; readonly type: string },
  ) =>
    Effect.map(
      // A first message waits on its classifier; the chain resolves meanwhile.
      Effect.all(
        [
          rejectTrashedFolder(threadContexts.turn(threadId, projectId), command),
          kindTurns.beforeTurn(threadId, message),
        ],
        { concurrency: 2 },
      ),
      ([turn, level]) => ({
        ...turn,
        instructions: withLevel(withLevel(turn.instructions, level), STATUS_LINE_INSTRUCTIONS),
      }),
    );

  const dispatchCommand = (
    actor: Actor,
    command: ThreadCommand,
    expectedRun?: ThreadCreation["expectedRun"],
  ) =>
    Effect.gen(function* () {
      const automationAnswer =
        command.type === "thread.ask.sync"
          ? null
          : yield* dispatchAutomationAskAnswer(actor, command, {
              threadSnapshot: (who, id) => threadSnapshot(who, id),
            });
      if (automationAnswer !== null) return automationAnswer;
      const threadId = commandThreadId(command);
      if (threadId === null) {
        return yield* ThreadCommandRejectedError.forCommand(
          { id: command.commandId, type: command.type },
          unsupported(),
        );
      }
      // Only a create can make a thread, so only a create names its place. The
      // thread object rejects a new thread without one, after replaying retries.
      const place =
        command.type === "thread.create"
          ? yield* rejectTrashedFolder(threadContexts.placeOfProject(command.projectId), {
              id: command.commandId,
              type: command.type,
            })
          : null;
      // Resolved on every turn start, so a thread that moved runs on its new home's chain.
      const turn = PICKS_A_POOL.has(command.type)
        ? yield* turnOf(
            threadId,
            command.type === "thread.create" ? command.projectId : null,
            messageOf(command),
            { id: command.commandId, type: command.type },
          )
        : null;
      if (command.type === "prepared-run.retry") {
        yield* rejectTrashedFolder(threadContexts.turn(threadId, null), {
          id: command.commandId,
          type: command.type,
        });
      }
      if (
        command.type !== "thread.create" &&
        (PICKS_A_POOL.has(command.type) || command.type === "queue.resume")
      ) {
        yield* refreshRemoteWorkspace(actor, threadId);
      }
      const creation = {
        ...placed(place, threadId, turn),
        ...(expectedRun === undefined ? {} : { expectedRun }),
      };
      if (
        command.type !== "message.dispatch" &&
        !(command.type === "queued-run.edit" && command.attachments !== undefined)
      ) {
        return yield* directory.forThread(threadId).dispatch(actor, command, creation);
      }
      return yield* withClaimed(
        attachments,
        {
          actor,
          threadId,
          command: { id: command.commandId, type: command.type },
          attachments: command.attachments ?? [],
        },
        (claimed) =>
          directory.forThread(threadId).dispatch(
            actor,
            {
              ...command,
              attachments: claimed,
              ...(command.type === "queued-run.edit" && command.context !== undefined
                ? {
                    context: remapComposerContextAttachments(
                      command.context,
                      command.attachments ?? [],
                      claimed,
                    ),
                  }
                : {}),
            },
            creation,
          ),
      );
    });

  const launchThread: Threads.Threads["Service"]["launch"] = (actor, input, lineage) =>
    Effect.gen(function* () {
      const place = yield* rejectTrashedFolder(threadContexts.placeOfProject(input.projectId), {
        id: input.commandId,
        type: "thread.launch",
      });
      if (input.reuseExistingThread === true && input.threadId !== undefined) {
        yield* refreshRemoteWorkspace(actor, input.threadId).pipe(
          Effect.catchTags({ ThreadNotFoundError: () => Effect.void }),
        );
      }
      // Receipts live in the thread's object, so a launch without an id needs
      // the same id on every retry: derive it from who launched and the command id.
      const threadId =
        input.threadId ??
        ThreadId.make(
          `thread:${yield* Effect.orDie(
            crypto
              .digest("SHA-256", new TextEncoder().encode(`${actor.userId}\n${input.commandId}`))
              .pipe(Effect.map(Hex.encode)),
          )}`,
        );
      // signalbox: Omitted launch models follow configured defaults while retries keep their accepted selection.
      let modelSelection =
        input.modelSelection ??
        (input.reuseExistingThread === true
          ? (yield* directory.forThread(threadId).snapshot(actor)).projection.thread.modelSelection
          : yield* rejectTrashedFolder(
              threadContexts.initialModelSelection(input.projectId, threadId),
              { id: input.commandId, type: "thread.launch" },
            ));
      if (modelSelection === null) {
        // A retry still returns the accepted thread after its default is cleared.
        modelSelection = yield* directory
          .forThread(threadId)
          .snapshot(actor)
          .pipe(
            Effect.map(({ projection }) => projection.thread.modelSelection),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          );
      }
      if (modelSelection === null) {
        return yield* ThreadCommandRejectedError.forCommand(
          { id: input.commandId, type: "thread.launch" },
          "Choose a model or set a default in Settings. No economical model is available.",
        );
      }
      const message = input.initialMessage;
      const creation = placed(
        place,
        threadId,
        yield* turnOf(
          threadId,
          input.projectId,
          message === undefined ? null : { text: message.text, title: input.title },
          { id: input.commandId, type: "thread.launch" },
        ),
      );
      return yield* withClaimed(
        attachments,
        {
          actor,
          threadId,
          command: { id: input.commandId, type: "thread.launch" },
          attachments: message?.attachments ?? [],
        },
        (claimed) =>
          directory.forThread(threadId).launch(
            actor,
            {
              ...input,
              threadId,
              modelSelection,
              ...(message === undefined
                ? {}
                : { initialMessage: { ...message, attachments: claimed } }),
            },
            { ...creation, ...(lineage === undefined ? {} : { lineage }) },
          ),
      );
    });

  const threadSnapshot: Threads.Threads["Service"]["snapshot"] = (actor, threadId) =>
    Effect.map(
      Effect.gen(function* () {
        const handle = directory.forThread(threadId);
        const snapshot = yield* handle.snapshot(actor);
        const adopted = yield* refreshWorkspace(actor, threadId, snapshot.projection.thread);
        return adopted ? yield* handle.snapshot(actor) : snapshot;
      }).pipe(Effect.catchTags({ ThreadCommandRejectedError: Effect.die })),
      ({ snapshotSequence, projection }) => ({
        snapshotSequence,
        projection,
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: projection.turnItems.reduce<number | null>(
          (latest, item) => (latest === null || item.ordinal > latest ? item.ordinal : latest),
          null,
        ),
      }),
    );

  const threadHistoryPage: Threads.Threads["Service"]["history"] = (actor, threadId) =>
    Effect.map(directory.forThread(threadId).snapshot(actor), ({ snapshotSequence }) => ({
      snapshotSequence,
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    }));

  const subscribeThread: Threads.Threads["Service"]["subscribe"] = (actor, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* refreshRemoteWorkspace(actor, input.threadId).pipe(
          Effect.catchTags({ ThreadCommandRejectedError: Effect.die }),
        );
        const handle = directory.forThread(input.threadId);
        const cursor = yield* Ref.make(input.afterSequence);
        yield* traceSynchronization("connecting", {
          side: "server",
          stream: "thread",
          threadId: input.threadId,
        });
        return yield* resuming({
          operation: "subscribe",
          threadId: input.threadId,
          open: Stream.unwrap(
            Effect.gen(function* () {
              const afterSequence = yield* Ref.get(cursor);
              yield* traceSynchronization(afterSequence === undefined ? "snapshot" : "resuming", {
                side: "server",
                stream: "thread",
                threadId: input.threadId,
                mode: afterSequence === undefined ? "snapshot" : "resume",
                ...(afterSequence === undefined ? {} : { afterSequence }),
              });
              return handle.subscribe(actor, {
                ...input,
                ...(afterSequence === undefined ? {} : { afterSequence }),
              });
            }),
          ),
          delivered: (batch) => {
            const next = cursorAfter(batch);
            return (
              batch.some((item) => item.kind === "synchronized")
                ? traceSynchronization("marker_emitted", {
                    side: "server",
                    stream: "thread",
                    threadId: input.threadId,
                  })
                : Effect.void
            ).pipe(Effect.andThen(next === undefined ? Effect.void : Ref.set(cursor, next)));
          },
        });
      }),
    );

  return Threads.Threads.of({
    subscribePreparation: (actor, threadId) =>
      Stream.unwrap(
        resuming({
          operation: "subscribePreparation",
          threadId,
          open: directory.forThread(threadId).subscribePreparation(actor),
          delivered: () => Effect.void,
        }),
      ),
    cancelPreparation: (actor, input) =>
      directory.forThread(input.threadId).cancelPreparation(actor, input),
    getWorkflowScript: (actor, input) =>
      directory.forThread(input.threadId).getWorkflowScript(actor, input),
    stopWorkflow: (actor, input) => directory.forThread(input.threadId).stopWorkflow(actor, input),
    launch: launchThread,
    dispatch: (actor, command, expectedRun) =>
      dispatchCommand(actor, clientAskCommand(command, actor.userId), expectedRun),
    answerAskAsAssistant: (actor, caller, command) =>
      dispatchCommand(actor, {
        ...command,
        answeredBy: { kind: "assistant", personId: actor.userId, assistantThreadId: caller },
      }),
    syncAutomationAsk: (actor, threadId, ask) =>
      dispatchCommand(actor, {
        type: "thread.ask.sync",
        commandId: CommandId.make(
          `automation-ask:${ask.id}:${ask.updatedAt}:${ask.status}:${ask.rounds.length}`,
        ),
        threadId,
        ask,
      }),
    refreshRemoteWorkspace,
    snapshot: threadSnapshot,
    history: threadHistoryPage,
    subscribe: subscribeThread,
    commandOutput: (actor, input) =>
      directory
        .forThread(input.threadId)
        .commandOutput(actor, input)
        .pipe(
          Stream.mapError(
            (cause) =>
              new OrchestrationV2CommandOutputError({
                threadId: input.threadId,
                message: "Couldn't read this command's output. It may no longer be available.",
                cause,
              }),
          ),
          Stream.concat(
            Stream.fail(
              new OrchestrationV2CommandOutputError({
                threadId: input.threadId,
                message: "Lost the command output stream. Reopen it to read the retained output.",
              }),
            ),
          ),
          Stream.takeUntil((frame) => !frame.running),
        ),
  });
});
