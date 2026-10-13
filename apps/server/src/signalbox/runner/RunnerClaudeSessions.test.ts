import type { SDKMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type {
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunnerShape,
  ClaudeAgentSdkQuerySession,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeClaudeSessions, withSessions } from "./RunnerClaudeSessions.ts";
import { makeSessionOutbox } from "./RunnerSessionOutbox.ts";
import { makeMemorySessionStore } from "./sessionStoreTesting.ts";

const key = { projectKey: "-home-runner-threads-thread-1", sessionId: "session-1" };

const makeSessions = Effect.gen(function* () {
  const store = makeMemorySessionStore();
  const outbox = yield* makeSessionOutbox({
    client: store.client,
    stallAfterMs: 60_000,
    onFailure: () => Effect.void,
  });
  const failures: Array<string> = [];
  const sessions = yield* makeClaudeSessions({
    client: store.client,
    outbox,
    onFailure: (message) => Effect.sync(() => void failures.push(message)),
  });
  return { store, sessions, failures };
});

const entry = (uuid: string, type = "assistant"): SessionStoreEntry => ({
  type,
  uuid,
  message: { content: [{ type: "thinking", thinking: "…", signature: "sig-ö" }] },
});

describe("RunnerClaudeSessions", () => {
  it.effect(
    "mirrors each SDK batch once, sidecars included, and loads it back on any machine",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { store, sessions } = yield* makeSessions;
          const batch = [entry("u1"), entry("u2", "user")];
          yield* Effect.promise(() => sessions.store.append(key, batch));
          // The SDK retries a batch it thinks failed with the same array.
          yield* Effect.promise(() => sessions.store.append(key, batch));
          yield* Effect.promise(() =>
            sessions.store.append({ ...key, subpath: "subagents/agent-a1" }, [entry("s1")]),
          );

          expect(store.streams.get("claude/session-1")).toHaveLength(2);
          // Another machine's working directory gives another project key; the session is the same.
          const elsewhere = { ...key, projectKey: "-workspace" };
          expect(yield* Effect.promise(() => sessions.store.load(elsewhere))).toEqual(batch);
          expect(yield* Effect.promise(() => sessions.store.listSubkeys!(elsewhere))).toEqual([
            "subagents/agent-a1",
          ]);
          expect(
            yield* Effect.promise(() => sessions.store.load({ ...key, sessionId: "never" })),
          ).toBeNull();
        }),
      ),
  );

  it.effect("answers the SDK at once while saving is stalled, and keeps the rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = makeMemorySessionStore();
        const outbox = yield* makeSessionOutbox({
          client: store.client,
          stallAfterMs: 1_000,
          onFailure: () => Effect.void,
        });
        const sessions = yield* makeClaudeSessions({
          client: store.client,
          outbox,
          onFailure: () => Effect.void,
        });
        store.state.down = true;
        const first = yield* Effect.forkChild(
          Effect.tryPromise(() => sessions.store.append(key, [entry("u1")])).pipe(
            Effect.as("saved"),
            Effect.orElseSucceed(() => "rejected"),
          ),
        );
        yield* TestClock.adjust(2_000);
        expect(yield* Fiber.join(first)).toBe("rejected");
        expect(yield* outbox.stalled).toBe(true);

        store.state.down = false;
        const drained = yield* Effect.forkChild(outbox.drain(60_000));
        yield* TestClock.adjust(10_000);
        yield* Fiber.join(drained);
        expect(store.streams.get("claude/session-1")).toHaveLength(1);
      }),
    ),
  );

  it.effect("holds a transcript message until its row is durable, and reports mirror_error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sessions, failures } = yield* makeSessions;
        const fromCli = yield* Queue.unbounded<SDKMessage>();
        const opened: Array<ClaudeAgentSdkQueryOpenInput> = [];
        const inner = {
          open: (input: ClaudeAgentSdkQueryOpenInput) =>
            Effect.sync(() => {
              opened.push(input);
              return {
                messages: Stream.fromQueue(fromCli),
              } as unknown as ClaudeAgentSdkQuerySession;
            }),
        } as unknown as ClaudeAgentSdkQueryRunnerShape;
        const query = yield* withSessions(inner, sessions).open({
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "session" as never,
          options: {} as never,
        });
        expect(opened[0]?.options).toMatchObject({ sessionStoreFlush: "eager" });
        expect(opened[0]?.options.sessionStore).toBe(sessions.store);

        const seen: Array<string> = [];
        const reading = yield* query.messages.pipe(
          Stream.runForEach((message) => Effect.sync(() => void seen.push(message.type))),
          Effect.forkChild,
        );
        yield* Queue.offer(fromCli, { type: "assistant", uuid: "u1" } as unknown as SDKMessage);
        for (let round = 0; round < 20; round++) yield* Effect.yieldNow;
        // The CLI writes the row after it streams the message.
        expect(seen).toEqual([]);
        yield* Effect.promise(() => sessions.store.append(key, [entry("u1")]));
        for (let round = 0; round < 20; round++) yield* Effect.yieldNow;
        expect(seen).toEqual(["assistant"]);

        yield* Queue.offer(fromCli, {
          type: "system",
          subtype: "mirror_error",
          error: "append timed out",
        } as unknown as SDKMessage);
        for (let round = 0; round < 20; round++) yield* Effect.yieldNow;
        expect(failures).toHaveLength(1);
        expect(seen).toEqual(["assistant", "system"]);
        yield* Fiber.interrupt(reading);
      }),
    ),
  );
});
