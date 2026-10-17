// @effect-diagnostics cryptoRandomUUID:off - secrets are generated throwaways.
import { expect, it } from "@effect/vitest";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { makeMemoryCloud } from "../../testing.ts";
import { UserDirectory } from "../../user/UserDirectory.ts";
import { readSecretSources } from "../secretRegistrationTesting.ts";
import { serveEgress } from "../Egress.ts";
import * as ThreadSends from "../ThreadSends.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { serveSessionRequest } from "../SessionRoutes.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  personal,
  send,
  turnReport,
  withObject,
} from "../runnerTesting.ts";

const a = `sk-a-${crypto.randomUUID()}`;
const b = `sk-b-${crypto.randomUUID()}`;
const rollbackValue = `sk-rollback-${crypto.randomUUID()}`;

it.effect(
  "A-to-B-to-A registration replaces current substitution values atomically while retaining redaction history",
  () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine, "rotation", personal);
        yield* connect(runner);
        const work = yield* runner.work;
        const token = work.sessions?.token ?? "";
        const runId = work.turn?.runId;
        if (runId === undefined) throw new Error("expected the active run");
        const sends = yield* ThreadSends.ThreadSends.pipe(
          Effect.provide(
            ThreadSends.layer.pipe(
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(Layer.succeed(UserDirectory, makeMemoryCloud().userDirectory)),
            ),
          ),
        );
        const store = Context.get(context, ThreadStore);
        const register = (value: string | null) =>
          serveSessionRequest({
            method: "POST",
            url: `http://cloud.test${SESSION_PATHS.secrets}`,
            token,
            body: JSON.stringify({
              runId,
              secrets: value === null ? [] : [{ name: "KEY", value }],
              current: value === null ? [] : [{ name: "KEY", value }],
            }),
          }).pipe(Effect.provide(context));
        let revision = yield* store.secretRevision;
        expect((yield* store.secretValues).revision).toBe(revision);
        for (const value of [a, b, a]) {
          expect((yield* register(value)).status).toBe(200);
          expect(yield* store.secretRevision).toBe(++revision);
          const current = yield* sends.secrets;
          expect(current.length === 1 && current[0]?.value === value).toBe(true);
        }
        expect((yield* store.secretValues).values).toHaveLength(2);
        const failed = yield* serveSessionRequest({
          method: "POST",
          url: `http://cloud.test${SESSION_PATHS.secrets}`,
          token,
          body: JSON.stringify({
            runId,
            secrets: [{ name: "KEY", value: rollbackValue }],
            current: [{ name: "KEY", value: rollbackValue }],
            sources: [
              { name: "KEY", environment: "env-one" },
              { name: "KEY", environment: "env-two" },
            ],
          }),
        }).pipe(Effect.provide(context));
        expect(failed.status).toBe(500);
        expect((yield* store.secretValues).revision).toBe(revision);
        expect((yield* sends.secrets)[0]?.value === a).toBe(true);
        expect((yield* store.secretValues).values).toHaveLength(2);
        expect((yield* register(null)).status).toBe(200);
        expect(yield* sends.secrets).toHaveLength(0);
        expect((yield* store.secretValues).values).toHaveLength(2);
      }),
    ),
);

it.effect(
  "a new secretless run clears current values and sources before rejecting the prior run's registration",
  () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const environment = OnePasswordEnvironmentId.make("env-folder-f");
        yield* launch(engine, "secret-run-1", {
          ...personal,
          secrets: { top: [], projects: {}, thread: [environment] },
        });
        const machine = yield* connect(runner);
        const first = yield* liveTurn(runner);
        const token = (yield* runner.work).sessions?.token ?? "";
        const store = Context.get(context, ThreadStore);
        const register = (runId: string, secrets: ReadonlyArray<{ name: string; value: string }>) =>
          serveSessionRequest({
            method: "POST",
            url: `http://cloud.test${SESSION_PATHS.secrets}`,
            token,
            body: JSON.stringify({
              runId,
              secrets,
              current: secrets,
              sources: secrets.length === 0 ? [] : [{ name: "KEY", environment }],
            }),
          }).pipe(Effect.provide(context));
        const sql = Context.get(context, SqlClient.SqlClient);

        expect((yield* register(first.runId, [{ name: "KEY", value: a }])).status).toBe(200);
        expect((yield* store.secretValues).current).toEqual([{ name: "KEY", value: a }]);
        expect(
          yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ).toEqual(new Map([["KEY", environment]]));

        const report = turnReport(first.runId, first.runOrdinal, first.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        expect((yield* register(first.runId, [{ name: "KEY", value: a }])).status).toBe(403);
        expect((yield* store.secretValues).current).toEqual([]);
        expect(
          yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ).toEqual(new Map());

        yield* send(engine, 2, "Again, from an empty folder", {
          ...personal,
          secrets: { top: [], projects: {}, thread: [] },
        });
        // The commit clears the previous turn before ThreadRunner.work makes it to the machine.
        const currentSecrets = yield* store.secretValues;
        expect(currentSecrets.current).toEqual([]);
        let authorizations = 0;
        const sent: Array<Request> = [];
        const egress = yield* Effect.promise(() =>
          serveEgress(
            new Request("https://hooks.example.test/", {
              headers: { "x-api-key": "{{secret:KEY}}" },
            }),
            {
              thread: {
                secrets: async () => currentSecrets,
                authorize: async () => {
                  authorizations += 1;
                  return { _tag: "allowed" };
                },
              },
              ownHosts: new Set(),
              send: async (request) => {
                sent.push(request);
                return new Response("sent");
              },
            },
          ),
        );
        expect(egress.status).toBe(403);
        expect(yield* Effect.promise(() => egress.text())).toContain("no secret called KEY");
        expect(authorizations).toBe(0);
        expect(sent).toEqual([]);
        const next = yield* runner.work;
        const secondRunId = next.turn?.runId;
        if (secondRunId === undefined) throw new Error("expected the next run");
        expect(next.generation).toBe(machine.generation);
        expect(secondRunId).not.toBe(first.runId);
        expect(next.secrets).toEqual([]);
        expect((yield* store.secretValues).current).toEqual([]);
        expect(
          yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ).toEqual(new Map());

        const late = yield* register(first.runId, [{ name: "KEY", value: a }]);
        expect(late.status).toBe(403);
        expect((yield* store.secretValues).current).toEqual([]);
        expect((yield* store.secretValues).values).toEqual([{ name: "KEY", value: a }]);

        expect((yield* register(secondRunId, [])).status).toBe(200);
        expect((yield* store.secretValues).current).toEqual([]);
        expect((yield* store.secretValues).values).toEqual([{ name: "KEY", value: a }]);
      }),
    ),
);
