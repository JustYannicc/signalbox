import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { CommandId, type ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { UserDirectory } from "../../user/UserDirectory.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  send,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runner/runnerTestKit.ts";
import type * as ThreadEngine from "../ThreadEngine.ts";
import { threadShellFromProjection } from "../threadProjection.ts";
import { saveSecretSources } from "./secretSendTables.ts";
import * as ThreadSends from "./ThreadSends.ts";

const environment = OnePasswordEnvironmentId.make("envfolder");
const HOST = "hooks.example.test";

/** The owner's object as the gate asks it: the grants it keeps, and what it answers. */
const fakeOwner = () => {
  const kept: Array<{ environmentId: string; name: string; host: string }> = [];
  let allowed = new Set<string>();
  const users = {
    forUser: () => ({
      secretSendsAllowed: ({ host }: { host: string }) =>
        Effect.succeed(
          [...allowed].filter((key) => key.endsWith(` ${host}`)).map((key) => key.split(" ")[0]!),
        ),
      keepSecretSends: (
        grants: ReadonlyArray<{ environmentId: string; name: string; host: string }>,
      ) =>
        Effect.sync(() => {
          kept.push(...grants);
          for (const grant of grants) allowed.add(`${grant.name} ${grant.host}`);
        }),
    }),
  } as unknown as UserDirectory["Service"];
  return {
    users,
    kept,
    revokeAll: () => {
      allowed = new Set();
    },
  };
};

/** The thread mid-turn on its machine, with the gate over it. */
const midTurn = <A, E>(
  owned: ReturnType<typeof fakeOwner>,
  use: (input: {
    readonly engine: ThreadEngine.ThreadEngine["Service"];
    readonly sends: ThreadSends.ThreadSends["Service"];
    readonly endTurn: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  withObject(freshDatabase(), (engine, runner, context) =>
    Effect.gen(function* () {
      yield* launch(engine);
      const machine = yield* connect(runner);
      const turn = yield* liveTurn(runner);
      const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
      let sequence = 0;
      const batch = (items: ReadonlyArray<RunnerItem>) =>
        runner.batch({ generation: machine.generation, sequence: ++sequence, items });
      yield* batch([report.started]);
      yield* saveSecretSources([{ name: "KEY", environment }]).pipe(
        Effect.provideService(SqlClient.SqlClient, Context.get(context, SqlClient.SqlClient)),
      );
      const endTurn = Effect.asVoid(batch([report.terminal]));
      return yield* ThreadSends.ThreadSends.use((sends) => use({ engine, sends, endTurn })).pipe(
        Effect.provide(
          ThreadSends.layer.pipe(
            Layer.provide(Layer.succeedContext(context)),
            Layer.provide(Layer.succeed(UserDirectory, owned.users)),
          ),
        ),
      );
    }),
  );

const respond = (
  engine: ThreadEngine.ThreadEngine["Service"],
  requestId: string,
  decision: ProviderApprovalDecision,
) =>
  engine.dispatch(
    owner,
    {
      type: "runtime-request.respond",
      commandId: CommandId.make(`respond-${requestId}-${decision}`),
      threadId,
      requestId: RuntimeRequestId.make(requestId),
      decision,
    },
    personal,
  );

const pendingRequests = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(snapshot(engine), ({ projection }) =>
    projection.runtimeRequests.filter((request) => request.status === "pending"),
  );

describe("ThreadSends", () => {
  it.effect(
    "asks once for a new host, waits for the answer, and sends for the rest of the turn",
    () =>
      midTurn(fakeOwner(), ({ engine, sends }) =>
        Effect.gen(function* () {
          const first = yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 });
          expect(first._tag).toBe("waiting");
          const [request] = yield* pendingRequests(engine);
          expect(request?.kind).toBe("permission");
          const { projection } = yield* snapshot(engine);
          // The thread waits on its person, as a harness's approval would have it.
          expect(threadShellFromProjection(projection).pendingRuntimeRequest?.id).toBe(request?.id);
          const row = projection.turnItems.find((item) => item.type === "approval_request");
          expect(row).toMatchObject({
            prompt: `An agent wants to send this secret to ${HOST}: KEY`,
            options: [
              { decision: "decline" },
              { decision: "acceptAlways", label: `Always send to ${HOST}` },
              { decision: "accept" },
            ],
          });

          // Sending again while the person hasn't answered doesn't ask twice.
          const waiting = yield* sends
            .authorize({ host: HOST, names: ["KEY"], waitMs: 60_000 })
            .pipe(Effect.forkChild);
          yield* respond(engine, request!.id, "accept");
          yield* sends.settle;
          expect(yield* Fiber.join(waiting)).toEqual({ _tag: "allowed" });
          expect((yield* snapshot(engine)).projection.runtimeRequests).toHaveLength(1);

          expect(yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 })).toEqual({
            _tag: "allowed",
          });
          const after = (yield* snapshot(engine)).projection;
          expect(threadShellFromProjection(after).pendingRuntimeRequest).toBeNull();
          const notices = after.turnItems.filter((item) => item.type === "system_notice");
          expect(notices.map((item) => item.type === "system_notice" && item.message)).toEqual([
            `Sent the secret KEY to ${HOST}.`,
          ]);
          // Another host is another question.
          expect(
            (yield* sends.authorize({ host: "other.example.test", names: ["KEY"], waitMs: 0 }))
              ._tag,
          ).toBe("waiting");
        }),
      ),
  );

  it.effect("asks once for sends made together", () =>
    midTurn(fakeOwner(), ({ engine, sends }) =>
      Effect.gen(function* () {
        const answers = yield* Effect.all(
          Array.from({ length: 5 }, () =>
            sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 }),
          ),
          { concurrency: "unbounded" },
        );
        expect(answers.map((answer) => answer._tag)).toEqual(Array(5).fill("waiting"));
        expect(yield* pendingRequests(engine)).toHaveLength(1);
      }),
    ),
  );

  it.effect("keeps an Always answer in the owner's object, which a revoke ends", () => {
    const owned = fakeOwner();
    return midTurn(owned, ({ engine, sends }) =>
      Effect.gen(function* () {
        yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 });
        const [request] = yield* pendingRequests(engine);
        yield* respond(engine, request!.id, "acceptAlways");
        yield* sends.settle;
        expect(owned.kept).toEqual([{ environmentId: environment, name: "KEY", host: HOST }]);
        expect((yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 }))._tag).toBe(
          "allowed",
        );

        owned.revokeAll();
        expect((yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 }))._tag).toBe(
          "waiting",
        );
      }),
    );
  });

  it.effect("refuses for the turn once the person says no, and asks again next turn", () =>
    midTurn(fakeOwner(), ({ engine, sends, endTurn }) =>
      Effect.gen(function* () {
        yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 });
        const [request] = yield* pendingRequests(engine);
        yield* respond(engine, request!.id, "decline");
        const refused = yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 });
        expect(refused).toEqual({
          _tag: "refused",
          message: `The person said no to sending KEY to ${HOST} this turn.`,
        });

        yield* endTurn;
        expect((yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 }))._tag).toBe(
          "refused",
        );
        yield* send(engine, 2, "again");
        expect((yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 }))._tag).toBe(
          "waiting",
        );
        expect(yield* pendingRequests(engine)).toHaveLength(1);
      }),
    ),
  );

  it.effect("lets an unanswered ask go when its turn ends", () =>
    midTurn(fakeOwner(), ({ engine, sends, endTurn }) =>
      Effect.gen(function* () {
        yield* sends.authorize({ host: HOST, names: ["KEY"], waitMs: 0 });
        yield* endTurn;
        const { projection } = yield* snapshot(engine);
        expect(projection.runtimeRequests.map((request) => request.status)).toEqual(["expired"]);
        expect(threadShellFromProjection(projection).pendingRuntimeRequest).toBeNull();
        // Too late to answer it.
        const late = yield* Effect.flip(
          respond(engine, projection.runtimeRequests[0]!.id, "accept"),
        );
        expect(late.message).toBe("That request isn't waiting for an answer anymore.");
      }),
    ),
  );
});
