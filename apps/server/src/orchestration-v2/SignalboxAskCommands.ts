import {
  MessageId,
  type ProjectId,
  type ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type {
  SignalboxAskServerCommand,
  SignalboxNativeAskRespondCommand,
} from "@t3tools/contracts/signalboxAsks";
import { applyAskCommand, nativeAskAnswerMessage } from "@t3tools/shared/signalboxAsks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { mirrorSignalboxAskEvents } from "./SignalboxAskEventMirror.ts";

type AskCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    type:
      | "thread.ask.raise"
      | "thread.ask.answer"
      | "thread.ask.withdraw"
      | "thread.ask.sync"
      | "thread.ask.considering.resume"
      | "thread.ask.considering.redefer"
      | "thread.ask.considering.fire";
  }
>;
type AskProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runtimeRequests" | "providerSessions" | "turnItems" | "messages"
>;

type AnswerDelivery = Extract<
  OrchestrationV2Command,
  { type: "message.dispatch" | "runtime-request.respond" }
>;

type ServerProjectHome = { readonly projectId: ProjectId; readonly workspaceRoot: string };

function planAskCommand(
  command: SignalboxAskServerCommand,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runtimeRequests" | "providerSessions" | "turnItems" | "messages"
  >,
  now: string,
  currentHome?: ServerProjectHome | null,
) {
  if (command.type === "thread.ask.considering.fire") {
    const expectedHome = command.expectedHome;
    if (
      expectedHome.kind !== "server" ||
      projection.thread.projectId !== expectedHome.projectId ||
      currentHome === undefined ||
      currentHome === null ||
      currentHome.projectId !== expectedHome.projectId ||
      currentHome.workspaceRoot !== expectedHome.workspaceRoot
    )
      return { ok: false as const, error: "This Considering ask's home changed." };
  }
  const considering =
    command.type === "thread.ask.raise" &&
    command.ask.kind === "considering" &&
    "considering" in command.ask &&
    command.ask.considering !== undefined
      ? command.ask.considering
      : command.type === "thread.ask.considering.redefer"
        ? command.considering
        : undefined;
  if (considering !== undefined) {
    if (
      new Set(considering.preparationAttachmentIds).size !==
      considering.preparationAttachmentIds.length
    )
      return { ok: false as const, error: "Preparation attachments must be unique." };
    const heldByThread = new Set(
      projection.messages.flatMap((message) =>
        message.attachments.map((attachment) => attachment.id),
      ),
    );
    if (considering.preparationAttachmentIds.some((id) => !heldByThread.has(id)))
      return {
        ok: false as const,
        error: "A preparation attachment isn't available in this thread.",
      };
  }
  if (
    projection.thread.deletedAt !== null ||
    (projection.thread.archivedAt !== null && command.type !== "thread.ask.sync")
  )
    return { ok: false as const, error: "This thread is archived or deleted." };
  if (
    command.type === "thread.ask.withdraw" &&
    projection.thread.asks?.find((ask) => ask.id === command.askId)?.source.kind === "automation"
  )
    return { ok: false as const, error: "Cancel the automation instead of withdrawing its ask." };
  const result = applyAskCommand(projection.thread.asks ?? [], command, now);
  if (!result.ok) return result;
  const answered = result.answered;
  if (!answered) return { ...result, deliveries: [] as AnswerDelivery[] };
  if (answered.ask.source.kind === "automation")
    return { ok: false as const, error: "Answer through the automation engine." };
  const requestId =
    answered.ask.source.kind === "native" ? answered.ask.source.requestId : undefined;
  const request = projection.runtimeRequests.find((request) => request.id === requestId);
  const nativeItem = projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === requestId,
  );
  const containsSecret =
    nativeItem?.type === "user_input_request" &&
    nativeItem.questions.some((question) => question.native?.isSecret === true);
  const capability = request?.responseCapability;
  const live =
    capability?.type === "live" &&
    projection.providerSessions.some(
      (session) =>
        session.id === capability.providerSessionId &&
        session.status !== "stopped" &&
        session.status !== "error",
    );
  // Keep partial rounds durable without queuing stale input behind the live callback.
  if (
    request?.status === "pending" &&
    live &&
    !containsSecret &&
    answered.ask.status !== "answered"
  )
    return { ...result, deliveries: [] as AnswerDelivery[] };
  // Partial rounds cannot complete a provider's synchronous callback.
  if (
    request?.status === "pending" &&
    live &&
    !containsSecret &&
    answered.ask.status === "answered"
  ) {
    const answers = Object.fromEntries(
      answered.ask.rounds.flatMap((round) =>
        round.answers.map((answer) => [answer.questionId, answer.value]),
      ),
    );
    const deliveries: AnswerDelivery[] = [
      {
        type: "runtime-request.respond",
        commandId: command.commandId,
        threadId: command.threadId,
        requestId: request.id,
        answers,
      },
    ];
    const comments = answered.ask.rounds.flatMap((round) => [
      ...(round.comment?.trim() ? [`Round ${round.number}: ${round.comment}`] : []),
      ...round.answers.flatMap((answer) =>
        answer.comment?.trim() ? [`[${answer.questionId}] ${answer.comment}`] : [],
      ),
    ]);
    if (comments.length) {
      deliveries.push({
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: MessageId.make(`ask-answer:${command.commandId}`),
        text: `Comments on ask ${answered.ask.id}:\n\n${comments.join("\n\n")}`,
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
    }
    return { ...result, deliveries };
  }
  return {
    ...result,
    deliveries: [
      {
        type: "message.dispatch",
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: MessageId.make(`ask-answer:${command.commandId}`),
        text:
          answered.ask.source.kind === "native" && request?.status !== "resolved"
            ? nativeAskAnswerMessage(answered.ask)
            : answered.message,
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
    ] satisfies AnswerDelivery[],
  };
}

export function dispatchSignalboxAskCommand<E>(input: {
  readonly command: AskCommand;
  readonly loadProjection: () => Effect.Effect<AskProjection, E>;
  readonly loadCurrentHome: (projectId: ProjectId) => Effect.Effect<ServerProjectHome | null, E>;
  readonly now: Effect.Effect<DateTime.Utc, E>;
  readonly dispatchDelivery: (delivery: AnswerDelivery) => Effect.Effect<void, E>;
  readonly emitAskUpdate: (
    thread: OrchestrationV2AppThread,
    asks: AskProjection["thread"]["asks"],
    now: DateTime.Utc,
  ) => Effect.Effect<void, E>;
  readonly pendingEvents: () => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E>;
  readonly dispatchError: (message: string) => E;
}) {
  return Effect.gen(function* () {
    const projection = yield* input.loadProjection();
    const now = yield* input.now;
    const currentHome =
      input.command.type === "thread.ask.considering.fire" &&
      input.command.expectedHome.kind === "server"
        ? yield* input.loadCurrentHome(input.command.expectedHome.projectId)
        : undefined;
    const plan = planAskCommand(input.command, projection, DateTime.formatIso(now), currentHome);
    if (!plan.ok) return yield* Effect.fail(input.dispatchError(plan.error));
    for (const delivery of plan.deliveries) yield* input.dispatchDelivery(delivery);
    if (plan.asks === projection.thread.asks) return;
    let thread = projection.thread;
    for (const event of yield* input.pendingEvents()) {
      if (
        event.threadId === input.command.threadId &&
        "archivedAt" in event.payload &&
        "modelSelection" in event.payload
      )
        thread = event.payload;
    }
    yield* input.emitAskUpdate(thread, plan.asks, now);
  });
}

export function dispatchSignalboxNativeAnswer<E>(input: {
  readonly command: typeof SignalboxNativeAskRespondCommand.Type;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly respond: (
    command: Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>,
  ) => Effect.Effect<void, E>;
  readonly loadProjection: (threadId: ThreadId) => Effect.Effect<AskProjection, E>;
}) {
  return Effect.gen(function* () {
    yield* input.respond({ ...input.command, type: "runtime-request.respond" });
    const events = yield* mirrorSignalboxAskEvents(
      yield* Ref.get(input.events),
      input.loadProjection,
      input.command,
    );
    yield* Ref.set(input.events, [...events]);
  });
}
