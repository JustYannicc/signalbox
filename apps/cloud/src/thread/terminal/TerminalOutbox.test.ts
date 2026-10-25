import { TerminalSessionSnapshot, ThreadId, type TerminalEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TerminalTesting from "../TerminalTesting.ts";

const threadId = ThreadId.make("thread-1");
const terminalId = "term-1";
const snapshot = (history = "current state"): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/scratch",
  worktreePath: null,
  status: "running",
  pid: 120,
  history,
  exitCode: null,
  exitSignal: null,
  label: "Shell",
  updatedAt: "2026-10-17T00:00:00.000Z",
  sequence: 4,
});

const event = (value: TerminalEvent): TerminalEvent => value;

describe("TerminalOutbox", () => {
  it.effect("compacts overflow to a state snapshot and preserves subprocess activity", () =>
    TerminalTesting.withTerminalOutbox((outbox) =>
      Effect.gen(function* () {
        const current = snapshot();
        for (const [sequence, data] of [
          [1, "a".repeat(100_000)],
          [2, "b".repeat(100_000)],
          [3, "c".repeat(100_000)],
        ] as const) {
          yield* outbox.append(
            event({ type: "output", threadId, terminalId, sequence, data }),
            current,
            true,
          );
        }

        const pending = yield* outbox.pending;
        expect(pending?.events.map((item) => item.type)).toEqual(["started", "activity"]);
        expect(pending?.events[0]).toMatchObject({
          type: "started",
          snapshot: { history: "current state", sequence: 4 },
        });
        expect(pending?.events[1]).toMatchObject({
          type: "activity",
          hasRunningSubprocess: true,
          label: "Shell",
          sequence: 4,
        });

        yield* outbox.acknowledge(pending!.sequence);
        expect(yield* outbox.hasPending).toBe(false);
      }),
    ),
  );

  it.effect("keeps a closed state when compaction replaces a full history", () =>
    TerminalTesting.withTerminalOutbox((outbox) =>
      Effect.gen(function* () {
        const current = snapshot("\0".repeat(128 * 1024));
        yield* outbox.append(
          event({ type: "started", threadId, terminalId, snapshot: current }),
          current,
        );
        expect((yield* outbox.pending)?.events.map((item) => item.type)).toEqual([
          "started",
          "activity",
        ]);

        yield* outbox.append(event({ type: "closed", threadId, terminalId }), current);
        const pending = yield* outbox.pending;
        expect(pending?.events).toEqual([{ type: "closed", threadId, terminalId }]);
      }),
    ),
  );
});
