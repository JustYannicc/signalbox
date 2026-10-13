import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerThreadObject } from "../../testing.ts";
import * as ThreadRunner from "../runner/ThreadRunner.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { serveSessionRequest } from "./sessionRoutes.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
};
const threadId = ThreadId.make("thread-sessions");
const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-fable-5-1" };

/** A thread object on a fresh database, and its session API as the Worker would call it. */
const withThread = <A, E>(
  use: (input: {
    readonly engine: ThreadEngine.ThreadEngine["Service"];
    readonly runner: ThreadRunner.ThreadRunner["Service"];
    readonly call: (
      token: string,
      path: string,
      body?: unknown,
    ) => Effect.Effect<{ readonly status: number; readonly body: unknown }>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(":memory:")).pipe(
      Effect.flatMap((context) =>
        use({
          engine: Context.get(context, ThreadEngine.ThreadEngine),
          runner: Context.get(context, ThreadRunner.ThreadRunner),
          call: (token, path, body) =>
            serveSessionRequest({
              method: body === undefined ? "GET" : "POST",
              url: `http://cloud.test${path}`,
              token,
              body:
                body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
            }).pipe(
              Effect.provide(context),
              Effect.map((answer) => ({
                status: answer.status,
                body: answer.json ? (JSON.parse(answer.body) as unknown) : answer.body,
              })),
            ),
        }),
      ),
    ),
  );

const send = (engine: ThreadEngine.ThreadEngine["Service"], ordinal: number) =>
  ordinal === 1
    ? engine.launch(
        owner,
        {
          commandId: CommandId.make("launch-1"),
          threadId,
          projectId: ProjectId.make("scratch"),
          title: "Sessions",
          modelSelection: claude,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
        },
        personal,
      )
    : engine.dispatch(
        owner,
        {
          type: "message.dispatch",
          commandId: CommandId.make(`send-${ordinal}`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make(`message-${ordinal}`),
          text: "Again",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        },
        personal,
      );

/** Asks for a machine, connects its Runner and answers its session token. */
const connect = (runner: ThreadRunner.ThreadRunner["Service"]) =>
  Effect.gen(function* () {
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.hello({
      type: "hello",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      imageVersion: "test",
      machineId: "machine-1",
      threadId,
      generation: plan.ensure.generation,
      token: plan.ensure.token,
      lastAckedSequence: 0,
    });
    const token = (yield* runner.work).sessions?.token;
    if (token === undefined) throw new Error("expected a session token");
    return { generation: plan.ensure.generation, token };
  });

const append = (stream: string, offset: number, rows: ReadonlyArray<string>) => ({
  stream,
  offset,
  rows,
});

describe("session API", () => {
  it.effect("stores each stream as a gapless prefix, every row once", () =>
    withThread(({ engine, runner, call }) =>
      Effect.gen(function* () {
        yield* send(engine, 1);
        const { token } = yield* connect(runner);
        const stream = "claude/session-1";

        expect(
          (yield* call(token, SESSION_PATHS.append, append(stream, 0, ["a", "b"]))).body,
        ).toEqual({ _tag: "stored", count: 2 });
        // A resend after a lost answer changes nothing; an overlap adds only what is new.
        expect(
          (yield* call(token, SESSION_PATHS.append, append(stream, 0, ["a", "b"]))).body,
        ).toEqual({ _tag: "stored", count: 2 });
        expect(
          (yield* call(token, SESSION_PATHS.append, append(stream, 1, ["b", "c"]))).body,
        ).toEqual({ _tag: "stored", count: 3 });
        // Rows past a gap never land.
        expect((yield* call(token, SESSION_PATHS.append, append(stream, 5, ["f"]))).body).toEqual({
          _tag: "gap",
          count: 3,
        });
        // A row over SQLite's value limit is stored in parts and read back whole.
        const big = `{"thinking":"${"x".repeat(1_200_000)}"}`;
        yield* call(token, SESSION_PATHS.append, append(stream, 3, [big]));
        yield* call(token, SESSION_PATHS.append, append(`${stream}/subagents/agent-1`, 0, ["s"]));

        const rows = yield* call(token, `${SESSION_PATHS.rows}?stream=${stream}`);
        expect(rows.body).toEqual({ rows: ["a", "b", "c", big], more: false });
        // Pages stop at about 4 MB of rows, and always carry at least one.
        for (let row = 4; row < 10; row++) {
          yield* call(token, SESSION_PATHS.append, append(stream, row, [big]));
        }
        const first = yield* call(token, `${SESSION_PATHS.rows}?stream=${stream}&from=2`);
        expect(first.body).toMatchObject({ more: true });
        const page = first.body as { readonly rows: ReadonlyArray<string> };
        expect(page.rows.slice(0, 2)).toEqual(["c", big]);
        expect(page.rows.length).toBeLessThan(8);
        expect((yield* call(token, `${SESSION_PATHS.streams}?prefix=claude/`)).body).toEqual({
          streams: [
            { stream, count: 10 },
            { stream: `${stream}/subagents/agent-1`, count: 1 },
          ],
        });
        expect((yield* call(token, `${SESSION_PATHS.streams}?prefix=${stream}/`)).body).toEqual({
          streams: [{ stream: `${stream}/subagents/agent-1`, count: 1 }],
        });

        expect((yield* call(token, SESSION_PATHS.append, "{")).status).toBe(400);
        expect(
          (yield* call("sbs1.x.y", SESSION_PATHS.append, append(stream, 10, ["d"]))).status,
        ).toBe(403);
      }),
    ),
  );

  it.effect("takes rows only from the machine holding the lease", () =>
    withThread(({ engine, runner, call }) =>
      Effect.gen(function* () {
        yield* send(engine, 1);
        const lost = yield* connect(runner);
        yield* call(lost.token, SESSION_PATHS.append, append("codex/rollout.jsonl", 0, ["a"]));
        yield* runner.ended(lost.generation, "test");
        yield* send(engine, 2);
        const current = yield* connect(runner);
        expect(current.generation).toBe(lost.generation + 1);

        const late = yield* call(
          lost.token,
          SESSION_PATHS.append,
          append("codex/rollout.jsonl", 1, ["b"]),
        );
        expect(late.status).toBe(403);
        const stored = yield* call(
          current.token,
          SESSION_PATHS.append,
          append("codex/rollout.jsonl", 1, ["b"]),
        );
        expect(stored.body).toEqual({ _tag: "stored", count: 2 });
      }),
    ),
  );
});
