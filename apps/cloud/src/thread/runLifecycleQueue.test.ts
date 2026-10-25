import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { activeRun, finishRunEvents } from "./runLifecycle.ts";
import { queuedRunsInDeliveryOrder } from "./queuedRunCommands.ts";
import { capabilities } from "./runnerTesting.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { decide, decideLaunch } from "./threadDecider.ts";
import { applyEvents } from "./threadProjection.ts";

const queueThreadId = ThreadId.make("thread-held-queue");
const queueContext = { now: DateTime.makeUnsafe("2026-10-18T10:00:00.000Z") };
const applyDecision = (
  current: OrchestrationV2ThreadProjection | null,
  decision: ReturnType<typeof decide>,
) => {
  if (decision._tag === "rejected") throw new Error(decision.message);
  const next = applyEvents(current, decision.events);
  if (next === null) throw new Error("Expected a thread");
  return next;
};
const initialQueueThread = () =>
  applyDecision(
    null,
    decideLaunch(
      null,
      {
        commandId: CommandId.make("launch-held-queue"),
        threadId: queueThreadId,
        projectId: ProjectId.make("scratch"),
        title: "Held queue",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message-initial"),
          text: "Initial",
          attachments: [],
        },
      },
      queueContext,
    ),
  );
const commandOn = (current: OrchestrationV2ThreadProjection, command: OrchestrationV2Command) =>
  applyDecision(current, decide(current, command, queueContext));
const sendQueuedMessage = (current: OrchestrationV2ThreadProjection, text: string) =>
  commandOn(current, {
    type: "message.dispatch",
    commandId: CommandId.make(`send-${text}`),
    threadId: queueThreadId,
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-${text}`),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  });
const messageText = (current: OrchestrationV2ThreadProjection, run: OrchestrationV2Run) =>
  current.messages.find((message) => message.id === run.userMessageId)?.text;
const queueTexts = (current: OrchestrationV2ThreadProjection) =>
  queuedRunsInDeliveryOrder(current).map((run) => messageText(current, run));
const finishActive = (
  current: OrchestrationV2ThreadProjection,
  queue: "advance" | "hold" | "keep" = "advance",
) => {
  const live = activeRun(current);
  if (live === undefined) throw new Error("Expected a live run");
  const next = applyEvents(
    current,
    finishRunEvents(current, live, "completed", queueContext, { queue }),
  );
  if (next === null) throw new Error("Expected a thread");
  return next;
};
const heldQueueWithNewMessages = () => {
  let current = sendQueuedMessage(sendQueuedMessage(initialQueueThread(), "A"), "B");
  const live = activeRun(current)!;
  current = commandOn(current, {
    type: "run.interrupt",
    commandId: CommandId.make("hold-initial"),
    threadId: queueThreadId,
    runId: live.id,
    holdQueue: true,
  });
  current = sendQueuedMessage(current, "C");
  current = sendQueuedMessage(sendQueuedMessage(current, "D"), "E");
  return current;
};

describe("mixed held and unheld queue delivery", () => {
  it("preserves held message order when a newer turn advances an unheld queue", () => {
    let current = heldQueueWithNewMessages();
    expect(queueTexts(current)).toEqual(["A", "B", "D", "E"]);
    expect(
      queuedRunsInDeliveryOrder(current).map((run) => [run.queuePosition, run.queueHeld === true]),
    ).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
    expect(messageText(current, activeRun(current)!)).toBe("C");
    current = finishActive(current);
    expect(messageText(current, activeRun(current)!)).toBe("D");
    expect(queueTexts(current)).toEqual(["A", "B", "E"]);
    expect(
      queuedRunsInDeliveryOrder(current).map((run) => [run.queuePosition, run.queueHeld === true]),
    ).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    current = commandOn(current, {
      type: "queue.resume",
      commandId: CommandId.make("resume"),
      threadId: queueThreadId,
    });
    const delivered: Array<string | undefined> = [];
    while (activeRun(current) !== undefined) {
      delivered.push(messageText(current, activeRun(current)!));
      current = finishActive(current);
    }
    expect(delivered).toEqual(["D", "A", "B", "E"]);
    expect(current.messages.map((message) => message.text)).toEqual([
      "Initial",
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(
      current.turnItems.filter((item) => item.type === "user_message").map((item) => item.text),
    ).toEqual(["Initial", "C", "D", "A", "B", "E"]);
  });

  it("keeps queued continuation order and holds every released message until resume", () => {
    const original = heldQueueWithNewMessages();
    let current = finishActive(original, "keep");
    expect(activeRun(current)).toBeUndefined();
    expect(queuedRunsInDeliveryOrder(current)).toEqual(queuedRunsInDeliveryOrder(original));
    current = sendQueuedMessage(current, "Continuation");
    expect(queueTexts(current)).toEqual(["A", "B", "D", "E"]);
    current = commandOn(current, {
      type: "queue.resume",
      commandId: CommandId.make("release-during-continuation"),
      threadId: queueThreadId,
    });
    expect(queuedRunsInDeliveryOrder(current).map((run) => run.queueHeld)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    current = finishActive(current, "hold");
    expect(activeRun(current)).toBeUndefined();
    expect(queueTexts(current)).toEqual(["A", "B", "D", "E"]);
    expect(queuedRunsInDeliveryOrder(current).map((run) => run.queueHeld)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    current = commandOn(current, {
      type: "queue.resume",
      commandId: CommandId.make("resume-held-continuation"),
      threadId: queueThreadId,
    });
    expect(messageText(current, activeRun(current)!)).toBe("A");
    expect(queueTexts(current)).toEqual(["B", "D", "E"]);
    expect(current.messages.map((message) => message.text)).toEqual([
      "Initial",
      "A",
      "B",
      "C",
      "D",
      "E",
      "Continuation",
    ]);
  });

  it("keeps a reordered held queue through cancellation and a new enqueue", () => {
    let current = finishActive(heldQueueWithNewMessages());
    const byText = (text: string) =>
      current.runs.find((run) => messageText(current, run) === text)!;
    current = commandOn(current, {
      type: "queued-run.reorder",
      commandId: CommandId.make("E-before-A"),
      threadId: queueThreadId,
      runId: byText("E").id,
      beforeRunId: byText("A").id,
    });
    current = commandOn(current, {
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-A"),
      threadId: queueThreadId,
      runId: byText("A").id,
    });
    current = sendQueuedMessage(current, "F");
    expect(queueTexts(current)).toEqual(["E", "B", "F"]);
    expect(byText("A").status).toBe("cancelled");
    current = commandOn(current, {
      type: "queue.resume",
      commandId: CommandId.make("resume-after-cancel"),
      threadId: queueThreadId,
    });
    const delivered: Array<string | undefined> = [];
    while (activeRun(current) !== undefined) {
      delivered.push(messageText(current, activeRun(current)!));
      current = finishActive(current);
    }
    expect(delivered).toEqual(["D", "E", "B", "F"]);
    expect(current.messages.map((message) => message.text)).toEqual([
      "Initial",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
  });

  it("keeps held order when an unheld queued message is promoted into the live turn", () => {
    let current = heldQueueWithNewMessages();
    const live = activeRun(current)!;
    if (
      live.providerThreadId === null ||
      live.activeAttemptId === null ||
      live.rootNodeId === null
    ) {
      throw new Error("Expected a started run");
    }
    const sessionId = ProviderSessionId.make("queue-steering-session");
    current = {
      ...current,
      runs: current.runs.map((run) => (run.id === live.id ? { ...run, status: "running" } : run)),
      providerThreads: current.providerThreads.map((thread) =>
        thread.id === live.providerThreadId ? { ...thread, providerSessionId: sessionId } : thread,
      ),
      providerSessions: [
        {
          id: sessionId,
          driver: ProviderDriverKind.make("scripted"),
          providerInstanceId: live.providerInstanceId,
          status: "running",
          cwd: "/tmp/thread",
          model: live.modelSelection.model,
          capabilities: {
            ...capabilities,
            turns: { ...capabilities.turns, supportsActiveSteering: true },
          },
          createdAt: queueContext.now,
          updatedAt: queueContext.now,
          lastError: null,
        },
      ],
      providerTurns: [
        {
          id: ProviderTurnId.make("queue-steering-turn"),
          providerThreadId: live.providerThreadId,
          nodeId: live.rootNodeId,
          runAttemptId: live.activeAttemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: queueContext.now,
          completedAt: null,
        },
      ],
    };
    const promoted = current.runs.find((run) => messageText(current, run) === "D")!;
    current = commandOn(current, {
      type: "queued-message.promote-to-steer",
      commandId: CommandId.make("promote-D"),
      threadId: queueThreadId,
      queuedRunId: promoted.id,
      targetRunId: live.id,
    });
    expect(queueTexts(current)).toEqual(["A", "B", "E"]);
    expect(current.runs.find((run) => run.id === promoted.id)?.status).toBe("cancelled");
    expect(current.messages.find((message) => message.text === "D")?.runId).toBe(live.id);
    expect(current.turnItems.filter((item) => item.type === "user_message")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "D",
          runId: live.id,
          inputIntent: "promoted_queued_to_steer",
        }),
      ]),
    );
    current = finishActive(current);
    expect(messageText(current, activeRun(current)!)).toBe("E");
    expect(queueTexts(current)).toEqual(["A", "B"]);
    current = commandOn(current, {
      type: "queue.resume",
      commandId: CommandId.make("resume-after-promotion"),
      threadId: queueThreadId,
    });
    current = finishActive(current);
    expect(messageText(current, activeRun(current)!)).toBe("A");
    current = finishActive(current);
    expect(messageText(current, activeRun(current)!)).toBe("B");
    current = finishActive(current);
    expect(activeRun(current)).toBeUndefined();
    expect(current.messages.map((message) => message.text)).toEqual([
      "Initial",
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });
});
