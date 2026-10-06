import { describe, expect, it } from "@effect/vitest";
import { AUTOMATION_EVENTS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { candidatesFor, MAPPED_EVENT_NAMES, type EventReads } from "./normalize.ts";

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
