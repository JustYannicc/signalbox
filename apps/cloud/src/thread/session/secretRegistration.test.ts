import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { RunId } from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { serveEgress } from "../egress/egress.ts";
import { readSecretSources } from "../egress/secretSendTables.ts";
import {
  connect,
  freshDatabase,
  launch,
  personal,
  send,
  turnReport,
  withObject,
} from "../runner/runnerTestKit.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { serveSessionRequest } from "./sessionRoutes.ts";

const values = [{ name: "KEY", value: "registration-fixture-canary" }];
const environment = OnePasswordEnvironmentId.make("registration-env");

describe("secret registration compatibility", () => {
  it.effect(
    "accepts the original payload for model masking without enabling substitutions or sends",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine, "legacy", {
            ...personal,
            secrets: { top: [environment], projects: {} },
          });
          yield* connect(runner);
          const work = yield* runner.work;
          const token = work.sessions?.token ?? "";
          const runId = work.turn?.runId;
          if (runId === undefined) throw new Error("expected the live run");
          const store = Context.get(context, ThreadStore);
          const sql = Context.get(context, SqlClient.SqlClient);
          const before = yield* store.secretValues;
          expect((yield* runner.authorizeModel(work.modelToken ?? "", "anthropic"))._tag).toBe(
            "unregistered",
          );
          const answer = yield* serveSessionRequest({
            method: "POST",
            url: `https://cloud.test${SESSION_PATHS.secrets}`,
            token,
            body: JSON.stringify({ secrets: values }),
          }).pipe(Effect.provide(context));
          expect(answer.status).toBe(200);
          const after = yield* store.secretValues;
          expect(after.values).toEqual(values);
          expect(after.current).toEqual([]);
          expect(after.registeredRunId).toBe(runId);
          expect(after.revision).toBe(before.revision + 1);
          expect(
            yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          ).toEqual(new Map());
          expect(yield* runner.authorizeModel(work.modelToken ?? "", "anthropic")).toMatchObject({
            _tag: "granted",
            secrets: values,
          });
          let authorizations = 0;
          let sends = 0;
          const response = yield* Effect.promise(() =>
            serveEgress(
              new Request("https://api.example.test/", {
                headers: { authorization: "Bearer {{secret:KEY}}" },
              }),
              {
                ownHosts: new Set(),
                thread: {
                  secrets: async () => after,
                  authorize: async () => {
                    authorizations++;
                    return { _tag: "allowed" };
                  },
                },
                dispatch: async () => {
                  sends++;
                  return { _tag: "sent", response: new Response("sent") };
                },
              },
            ),
          );
          expect(response.status).toBe(403);
          expect(authorizations).toBe(0);
          expect(sends).toBe(0);
        }),
      ),
  );

  it.effect("refuses legacy registration from an old lease or without a live run", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const old = yield* connect(runner);
        const work = yield* runner.work;
        const token = work.sessions?.token ?? "";
        const turn = work.turn;
        if (turn === null) throw new Error("expected the live turn");
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: old.generation,
          sequence: 1,
          items: [report.started, report.terminal],
        });
        const call = (session: string) =>
          serveSessionRequest({
            method: "POST",
            url: `https://cloud.test${SESSION_PATHS.secrets}`,
            token: session,
            body: JSON.stringify({ secrets: values }),
          }).pipe(Effect.provide(context));
        expect((yield* runner.authorizeSession(token))._tag).toBe("granted");
        expect(yield* runner.registerSecrets(token, { secrets: values })).toEqual({
          _tag: "denied",
          reason: "run",
        });
        expect((yield* call(token)).status).toBe(403);
        yield* runner.ended(old.generation, "test");
        yield* send(engine, 2, "Again");
        yield* connect(runner);
        expect((yield* call(token)).status).toBe(403);
        expect((yield* Context.get(context, ThreadStore).secretValues).values).toEqual([]);
      }),
    ),
  );

  it.effect(
    "rejects partial new payloads and the wrong current run without changing the snapshot",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* connect(runner);
          const work = yield* runner.work;
          const token = work.sessions?.token ?? "";
          const runId = work.turn?.runId;
          if (runId === undefined) throw new Error("expected the live run");
          const store = Context.get(context, ThreadStore);
          const before = yield* store.secretValues;
          const call = (body: unknown) =>
            serveSessionRequest({
              method: "POST",
              url: `https://cloud.test${SESSION_PATHS.secrets}`,
              token,
              body: JSON.stringify(body),
            }).pipe(Effect.provide(context));
          for (const body of [
            { runId, secrets: values },
            { current: values, secrets: values },
            { sources: [], secrets: values },
            { runId: null, secrets: values },
            { runId, current: null, secrets: values },
            { runId, current: [], secrets: values, sources: null },
            { secrets: "not a list" },
            { secrets: [{ name: "not a name", value: "invalid" }] },
            { secrets: values, futureField: true },
          ]) {
            expect((yield* call(body)).status, Object.keys(body).join(",")).toBe(400);
            expect(yield* store.secretValues).toEqual(before);
          }
          expect(
            (yield* call({ runId: "wrong-run", secrets: values, current: values })).status,
          ).toBe(403);
          expect(yield* store.secretValues).toEqual(before);
        }),
      ),
  );

  it.effect("owns typed outcomes, source replacement and rollback in the domain transaction", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* connect(runner);
        const work = yield* runner.work;
        const token = work.sessions?.token ?? "";
        const runId = work.turn?.runId;
        if (runId === undefined) throw new Error("expected the live run");
        const store = Context.get(context, ThreadStore);
        const sql = Context.get(context, SqlClient.SqlClient);
        const registration = {
          runId,
          secrets: values,
          current: values,
          sources: [{ name: "KEY", environment }],
        };
        expect(yield* runner.registerSecrets(`${token}x`, registration)).toEqual({
          _tag: "denied",
          reason: "lease",
        });
        expect(
          yield* runner.registerSecrets(token, { ...registration, runId: RunId.make("wrong-run") }),
        ).toEqual({ _tag: "denied", reason: "run" });
        expect(yield* runner.registerSecrets(token, registration)).toEqual({
          _tag: "registered",
          warnings: [],
        });
        const before = yield* store.secretValues;
        const badValues = [{ name: "KEY", value: "registration-rollback-canary" }];
        expect(
          yield* runner.registerSecrets(token, {
            ...registration,
            secrets: badValues,
            current: badValues,
            sources: [registration.sources[0]!, registration.sources[0]!],
          }),
        ).toEqual({ _tag: "unavailable" });
        expect(yield* store.secretValues).toEqual(before);
        expect(
          yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ).toEqual(new Map([["KEY", environment]]));

        expect(yield* runner.registerSecrets(token, { secrets: values })).toEqual({
          _tag: "denied",
          reason: "capability",
        });
        expect(yield* store.secretValues).toEqual(before);
        expect(
          yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ).toEqual(new Map([["KEY", environment]]));
      }),
    ),
  );

  it.effect(
    "returns names-only binary-protection warnings at the first cloud value-custody write",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* connect(runner);
          const work = yield* runner.work;
          const runId = work.turn?.runId;
          if (runId === undefined) throw new Error("expected the live run");
          const secrets = [
            { name: "ONE", value: "1" },
            { name: "THREE", value: "abc" },
            { name: "SEVEN", value: "abcd猫" },
            { name: "EIGHT", value: "abcde猫" },
          ];
          const answer = yield* serveSessionRequest({
            method: "POST",
            url: `https://cloud.test${SESSION_PATHS.secrets}`,
            token: work.sessions?.token ?? "",
            body: JSON.stringify({ runId, secrets, current: secrets }),
          }).pipe(Effect.provide(context));
          expect(answer.status).toBe(200);
          expect(answer.json).toBe(true);
          expect(JSON.parse(answer.body)).toEqual({
            warnings: [
              { name: "ONE", code: "binary_secret_too_short" },
              { name: "SEVEN", code: "binary_secret_too_short" },
              { name: "THREE", code: "binary_secret_too_short" },
            ],
          });
          expect(answer.body).not.toContain("abcd猫");
          expect(answer.body).not.toContain("abcde猫");
          expect((yield* Context.get(context, ThreadStore).secretValues).current).toEqual(
            [...secrets].toSorted((a, b) => a.name.localeCompare(b.name)),
          );
        }),
      ),
  );
});
