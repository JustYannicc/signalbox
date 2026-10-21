import { describe, expect, it } from "@effect/vitest";
import { AUTOMATION_EVENTS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  candidatesFor,
  MAPPED_EVENT_NAMES,
  type EventReads,
} from "@signalbox/automations/events/normalize";

const AT = DateTime.makeUnsafe("2026-10-06T10:00:00.000Z");
const reads = { shell: Effect.succeed(null), threads: {} as never } satisfies EventReads;

describe("candidatesFor", () => {
  it("builds every catalog event, except the engine's own", () => {
    const catalog = AUTOMATION_EVENTS.map((spec) => spec.name).filter(
      (name) => !name.startsWith("automation."),
    );
    expect([...MAPPED_EVENT_NAMES].toSorted()).toEqual(catalog.toSorted());
  });

  it("passes events it doesn't know through raw instead of dropping them", () => {
    const candidates = candidatesFor({
      id: "event-1",
      type: "some.new-event",
      threadId: "thread-1",
      occurredAt: AT,
      payload: {},
    } as never);
    expect(candidates.map((candidate) => candidate.name)).toEqual(["orchestration.some.new-event"]);
  });

  it.effect("publishes only content-free ask state and keeps the domain occurrence id", () =>
    Effect.gen(function* () {
      let shellReads = 0;
      const event = {
        id: "ask-event-1",
        type: "thread.ask-updated",
        threadId: "thread-current-folder",
        occurredAt: AT,
        payload: {
          id: "ask-1",
          kind: "considering",
          status: "pending",
          source: { kind: "automation", runId: "run-1", stepKey: "ask" },
          questions: [
            {
              id: "question-1",
              question: "PRIVATE QUESTION",
              why: "PRIVATE WHY",
              unblocks: "PRIVATE UNBLOCK",
              recommendation: "PRIVATE RECOMMENDATION",
              options: [],
              blocking: false,
              decisionOwner: "PRIVATE OWNER",
              surface: { kind: "kit", component: "ask" },
            },
          ],
          considering: {
            exit: { kind: "event", name: "PRIVATE EXIT" },
            preparationAttachmentIds: [],
            revision: 4,
            fired: {
              at: "2026-10-06T10:00:00.000Z",
              source: "event",
              whatChanged: "PRIVATE PROOF",
            },
          },
          rounds: [
            {
              number: 3,
              questionIds: ["question-1"],
              answers: [
                {
                  questionId: "question-1",
                  value: "PRIVATE ANSWER",
                  comment: "PRIVATE COMMENT",
                  answeredBy: { kind: "person", personId: "person-1" },
                  recommendationTaken: false,
                  answeredAt: "2026-10-06T10:00:00.000Z",
                },
              ],
              deferredQuestionIds: [],
              comment: "PRIVATE ROUND COMMENT",
              openedAt: "2026-10-06T10:00:00.000Z",
              closedAt: null,
            },
          ],
          createdAt: "2026-10-06T10:00:00.000Z",
          updatedAt: "2026-10-06T10:00:00.000Z",
        },
      };
      const candidates = candidatesFor(event as never);
      const [askChanged] = candidates;

      expect(candidates.map((candidate) => candidate.name)).toEqual([
        "ask.changed",
        "orchestration.thread.ask-updated",
      ]);
      expect(askChanged).toMatchObject({
        id: "ask.changed:ask-event-1",
        name: "ask.changed",
      });
      expect(askChanged!.projectId).toBeUndefined();
      const fields = yield* askChanged!.build({
        shell: Effect.sync(() => {
          shellReads += 1;
          return null;
        }),
        threads: {} as never,
      });
      expect(fields).toEqual({
        askId: "ask-1",
        kind: "considering",
        status: "pending",
        sourceKind: "automation",
        round: 3,
        revision: 4,
        exitKind: "event",
        fired: true,
      });
      expect(JSON.stringify(fields)).not.toContain("PRIVATE");
      expect(shellReads).toBe(0);
      expect(candidatesFor(event as never)[0]?.id).toBe(askChanged?.id);
      expect(candidatesFor({ ...event, id: "ask-event-2" } as never)[0]?.id).not.toBe(
        askChanged?.id,
      );
    }),
  );

  it.effect("keeps legacy and non-Considering exits empty", () =>
    Effect.gen(function* () {
      for (const kind of ["considering", "ready"] as const) {
        const id = `ask-${kind}`;
        const [askChanged] = candidatesFor({
          id: `event-${id}`,
          type: "thread.ask-updated",
          threadId: "thread-current-folder",
          occurredAt: AT,
          payload: {
            id,
            kind,
            status: "pending",
            source: { kind: "agent" },
            rounds: [{ number: 1 }],
          },
        } as never);

        expect(yield* askChanged!.build(reads)).toEqual({
          askId: id,
          kind,
          status: "pending",
          sourceKind: "agent",
          round: 1,
          revision: null,
          exitKind: null,
          fired: false,
        });
      }
    }),
  );

  it.effect("reports a finished command as a tool call, once per item", () =>
    Effect.gen(function* () {
      const event = (status: string) =>
        ({
          id: `event-${status}`,
          type: "turn-item.updated",
          threadId: "thread-1",
          runId: "run-1",
          occurredAt: AT,
          payload: {
            id: "item-1",
            type: "command_execution",
            threadId: "thread-1",
            runId: "run-1",
            status,
            title: "Run tests",
            input: "vp test run",
            output: "1 failed",
            exitCode: 1,
            updatedAt: AT,
          },
        }) as never;
      const running = candidatesFor(event("running"));
      expect(running.map((candidate) => candidate.name)).toEqual([
        "tool.started",
        "orchestration.turn-item.updated",
      ]);
      const [called] = candidatesFor(event("completed"));
      expect(called).toMatchObject({ name: "tool.called", id: "tool.called:item-1" });
      expect(yield* called!.build(reads)).toMatchObject({
        tool: "command",
        input: "vp test run",
        output: "1 failed",
        exitCode: 1,
        failed: true,
      });
    }),
  );
});

describe("turn.finished", () => {
  it.effect("says why a turn stopped, including when a usage limit lifts", () =>
    Effect.gen(function* () {
      const [finished] = candidatesFor({
        id: "event-limit",
        type: "run.updated",
        threadId: "thread-1",
        runId: "run-1",
        occurredAt: AT,
        payload: {
          id: "run-1",
          threadId: "thread-1",
          status: "failed",
          providerInstanceId: "claudeAgent",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
          startedAt: AT,
          completedAt: AT,
        },
      } as never);
      const fields = yield* finished!.build({
        shell: Effect.succeed({
          lastErrorClass: "usage_limit",
          usageLimitResetAt: "2026-10-06T15:00:00.000Z",
          branch: null,
          worktreePath: null,
        } as never),
        threads: {
          getThreadRecords: () => Effect.succeed({ messages: [], turnItems: [] }),
        } as never,
      });
      expect(fields).toMatchObject({
        status: "failed",
        errorClass: "usage_limit",
        usageLimitResetAt: "2026-10-06T15:00:00.000Z",
      });
    }),
  );
});
