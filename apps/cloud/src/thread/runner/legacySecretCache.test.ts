import { RunId } from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { scrubModelRequest } from "../../modelGateway/scrubModelRequest.ts";
import { readSecretSources } from "../egress/secretSendTables.ts";
import { ThreadStore } from "../ThreadStore.ts";
import {
  connect,
  freshDatabase,
  hello,
  launch,
  personal,
  send,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";

const envA = OnePasswordEnvironmentId.make("legacy-env-a");
const envB = OnePasswordEnvironmentId.make("legacy-env-b");
const valueA = { name: "KEY", value: "legacy-cache-first-fixture" };
const valueB = { name: "KEY", value: "legacy-cache-second-fixture" };
const creation = (environment: OnePasswordEnvironmentId) => ({
  ...personal,
  secrets: { top: [environment], projects: {} },
});

describe("legacy redaction-only generations", () => {
  it.effect(
    "supports the base Runner's cached second turn, reloads sources and fences a replacement lease",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine, "legacy-cache", creation(envA));
          const machine = yield* connect(runner);
          const first = yield* runner.work;
          const firstTurn = first.turn;
          if (firstTurn === null) throw new Error("expected the first turn");
          const session = first.sessions?.token ?? "";
          const store = Context.get(context, ThreadStore);
          const sql = Context.get(context, SqlClient.SqlClient);
          expect(yield* runner.registerSecrets(session, { secrets: [valueA] })).toEqual({
            _tag: "registered",
            warnings: [],
          });
          expect((yield* runner.authorizeModel(first.modelToken ?? "", "anthropic"))._tag).toBe(
            "granted",
          );
          const firstReport = turnReport(
            firstTurn.runId,
            firstTurn.runOrdinal,
            firstTurn.providerThread,
          );
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [firstReport.started, firstReport.terminal],
          });
          yield* send(engine, 2, "Use the cached secrets", creation(envA));
          const second = yield* runner.work;
          const secondTurn = second.turn;
          if (secondTurn === null) throw new Error("expected the second turn");
          // The base Runner returns from its unchanged-source cache without another POST.
          expect(secondTurn.runId).not.toBe(firstTurn.runId);
          const cached = yield* runner.authorizeModel(second.modelToken ?? "", "anthropic");
          expect(cached._tag).toBe("granted");
          if (cached._tag !== "granted") throw new Error("cached masking must remain available");
          expect((yield* store.secretValues).current).toEqual([]);
          expect(
            yield* readSecretSources.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          ).toEqual(new Map());
          const scrubbed = scrubModelRequest(
            new Request("https://model.test/messages", { method: "POST", body: valueA.value }),
            cached.secrets,
          );
          expect(scrubbed._tag).toBe("scrubbed");
          if (scrubbed._tag !== "scrubbed") throw new Error("expected model masking");
          expect(yield* Effect.promise(() => scrubbed.request.text())).toBe("{{secret:KEY}}");

          const secondReport = turnReport(
            secondTurn.runId,
            secondTurn.runOrdinal,
            secondTurn.providerThread,
          );
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [secondReport.started, secondReport.terminal],
          });
          yield* send(engine, 3, "Load a different source", creation(envB));
          const third = yield* runner.work;
          expect((yield* runner.authorizeModel(third.modelToken ?? "", "anthropic"))._tag).toBe(
            "unregistered",
          );
          expect(yield* runner.registerSecrets(session, { secrets: [valueB] })).toEqual({
            _tag: "registered",
            warnings: [],
          });
          expect(yield* runner.authorizeModel(third.modelToken ?? "", "anthropic")).toMatchObject({
            _tag: "granted",
            secrets: [valueA, valueB],
          });
          expect((yield* store.secretValues).current).toEqual([]);

          yield* runner.ended(machine.generation, "test");
          yield* send(engine, 4, "On a replacement machine", creation(envB));
          const replacement = yield* connect(runner);
          expect(replacement.generation).toBeGreaterThan(machine.generation);
          const fourth = yield* runner.work;
          expect((yield* runner.authorizeModel(fourth.modelToken ?? "", "anthropic"))._tag).toBe(
            "unregistered",
          );
          expect(yield* runner.registerSecrets(session, { secrets: [valueB] })).toEqual({
            _tag: "denied",
            reason: "lease",
          });
          expect(
            (yield* runner.registerSecrets(fourth.sessions?.token ?? "", { secrets: [valueB] }))
              ._tag,
          ).toBe("registered");
        }),
      ),
  );

  it.effect("never downgrades an advertised capability on reconnect or a legacy-shaped POST", () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine, "modern-cache", creation(envA));
        const machine = yield* connect(runner);
        yield* runner.hello({
          ...hello(machine.generation, machine.token),
          runScopedSecrets: true,
        });
        const work = yield* runner.work;
        const turn = work.turn;
        if (turn === null) throw new Error("expected the modern turn");
        const token = work.sessions?.token ?? "";
        const registration = { runId: turn.runId, secrets: [valueA], current: [valueA] };
        expect(yield* runner.registerSecrets(token, { secrets: [valueA] })).toEqual({
          _tag: "denied",
          reason: "capability",
        });
        expect(
          yield* runner.registerSecrets(token, { ...registration, runId: RunId.make("wrong-run") }),
        ).toEqual({ _tag: "denied", reason: "run" });
        expect((yield* runner.registerSecrets(token, registration))._tag).toBe("registered");
        yield* runner.hello({
          ...hello(machine.generation, machine.token),
          runScopedSecrets: false,
        });
        yield* runner.hello(hello(machine.generation, machine.token));
        expect((yield* Context.get(context, ThreadStore).machine).runScopedSecrets).toBe(true);
        expect((yield* runner.registerSecrets(token, { secrets: [valueA] }))._tag).toBe("denied");
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started, report.terminal],
        });
        yield* send(engine, 2, "A modern second turn", creation(envA));
        const next = yield* runner.work;
        expect((yield* runner.authorizeModel(next.modelToken ?? "", "anthropic"))._tag).toBe(
          "unregistered",
        );
        expect((yield* runner.registerSecrets(token, registration))._tag).toBe("denied");
        expect((yield* runner.registerSecrets(token, { secrets: [valueA] }))._tag).toBe("denied");
        expect((yield* Context.get(context, ThreadStore).secretValues).current).toEqual([]);
      }),
    ),
  );

  it.effect(
    "retains pre-0013 legacy receipt masking, and an advertised upgrade requires a fresh run registration",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine, "migrated-legacy", creation(envA));
          const machine = yield* connect(runner);
          const work = yield* runner.work;
          const runId = work.turn?.runId;
          if (runId === undefined) throw new Error("expected the live run");
          const sql = Context.get(context, SqlClient.SqlClient);
          // The upgrade fixture proves 0013 retains this original generation receipt and history.
          yield* sql`INSERT INTO secret_values (name, value) VALUES (${valueA.name}, ${valueA.value})`;
          yield* sql`INSERT INTO secret_registration (id, generation, run_id) VALUES (1, ${machine.generation}, NULL)`;
          expect((yield* runner.authorizeModel(work.modelToken ?? "", "anthropic"))._tag).toBe(
            "granted",
          );
          expect((yield* Context.get(context, ThreadStore).secretValues).current).toEqual([]);
          yield* runner.hello({
            ...hello(machine.generation, machine.token),
            runScopedSecrets: true,
          });
          expect((yield* runner.authorizeModel(work.modelToken ?? "", "anthropic"))._tag).toBe(
            "unregistered",
          );
          expect(
            (yield* runner.registerSecrets(work.sessions?.token ?? "", {
              runId,
              secrets: [valueA],
              current: [valueA],
            }))._tag,
          ).toBe("registered");
          expect((yield* runner.authorizeModel(work.modelToken ?? "", "anthropic"))._tag).toBe(
            "granted",
          );
        }),
      ),
  );
});
