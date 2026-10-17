// @effect-diagnostics cryptoRandomUUID:off cryptoRandomUUIDInEffect:off - fake secrets are generated per run, so no test ever holds a real one.
import type { MachineUsage, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { ProjectId, type RunId } from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { makeMemoryCloud } from "../../testing.ts";
import { serveSessionRequest } from "../session/sessionRoutes.ts";
import * as ThreadContexts from "../../user/threadContexts.ts";
import * as UserFolders from "../../user/UserFolders.ts";
import * as CloudAnalytics from "../diagnostics/CloudAnalytics.ts";
import { FINALIZE_GRACE_MS, TurnReports } from "../diagnostics/TurnReports.ts";
import { IDLE_TAIL_MS } from "./MachineBackend.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";
import { DRAIN_TIMEOUT_MS } from "./ThreadRunner.ts";

/**
 * The cloud half of #395's promise: the owner's 1Password token goes to the
 * thread's machine in `turn.start` and nowhere else. Their own object stores
 * it; no thread event, projection, diagnostics record, analytics payload,
 * log line or span carries it.
 */

const TOKEN = "ops_leak-canary-7f3a9c2e51";
const userId = owner.userId;

/** Every log line and span the objects make, as text. */
const observed = () => {
  const lines: Array<string> = [];
  const spans: Array<Tracer.NativeSpan> = [];
  const layer = Layer.mergeAll(
    Logger.layer(
      [
        Logger.map(Logger.formatJson, (line) => {
          lines.push(line);
        }),
      ],
      { mergeWithExisting: true },
    ),
    // Debug lines too: a level away from being shipped.
    Layer.succeed(References.MinimumLogLevel, "All"),
    Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    ),
  );
  const text = () =>
    [
      ...lines,
      ...spans.map((span) =>
        text_({ name: span.name, attributes: [...span.attributes], events: span.events }),
      ),
    ].join("\n");
  return { layer, spans, text };
};

/** JSON that also reads bigints and blobs as text, so nothing hides from `toContain`. */
const text_ = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint"
      ? entry.toString()
      : entry instanceof Uint8Array
        ? new TextDecoder().decode(entry)
        : entry,
  );

/** Every row of every table, but `except`. */
const dump = (sql: SqlClient.SqlClient, except: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const tables = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
    const rows: Record<string, unknown> = {};
    for (const { name } of tables) {
      if (!except.includes(name)) rows[name] = yield* sql`SELECT * FROM ${sql(name)}`;
    }
    expect(Object.keys(rows).length).toBeGreaterThan(0);
    return text_(rows);
  });

/** A PostHog that records each batch's request body. */
const layerPostHog = (sent: Array<unknown>) =>
  CloudAnalytics.layerOn({ key: "phc_test", host: "https://posthog.test" }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag === "Uint8Array") {
              sent.push(JSON.parse(new TextDecoder().decode(request.body.body)));
            }
            return HttpClientResponse.fromWeb(request, Response.json({ status: 1 }));
          }),
        ),
      ),
    ),
  );

const usage = (runId: RunId, cpuSeconds: number): RunnerItem => ({
  kind: "usage",
  runId,
  usage: {
    cpuSeconds,
    memoryBytes: 300_000_000,
    memoryPeakBytes: 300_000_000,
    memoryAverageBytes: 300_000_000,
    diskUsedBytes: 4_000_000_000,
    egressBytes: 1_000_000,
  } satisfies MachineUsage,
});

const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

describe("folder secrets", () => {
  it.effect(
    "keep the 1Password token out of everything the cloud stores, reports, logs and traces",
    () => {
      const watch = observed();
      const cloud = makeMemoryCloud({ observe: watch.layer });
      const sent: Array<unknown> = [];
      const environments = [
        OnePasswordEnvironmentId.make("env-top"),
        OnePasswordEnvironmentId.make("env-work"),
      ];
      return Effect.gen(function* () {
        // The owner connects 1Password and names Environments, as the web does.
        yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
        const { folders, contexts } = yield* Effect.all({
          folders: UserFolders.UserFolders,
          contexts: ThreadContexts.ThreadContexts,
        }).pipe(Effect.provide(cloud.layerFor(userId)));
        const work = (yield* folders.create({ name: "Work", parentId: null })).folders[0]!.id;
        yield* folders.setSecrets({
          level: { _tag: "top" },
          secrets: { environmentId: environments[0]! },
        });
        yield* folders.setSecrets({
          level: { _tag: "folder", folderId: work },
          secrets: { environmentId: environments[1]! },
        });
        const connected = yield* folders.setOnePassword({ token: TOKEN });
        yield* folders.moveThread({ threadId, folderId: work });
        // What a launch from the owner's object carries to the thread.
        const turn = yield* contexts.turn(threadId, ProjectId.make("scratch"));
        expect(turn.secrets.thread).toEqual(environments);

        yield* withObject(
          freshDatabase(),
          (engine, runner, context) =>
            Effect.gen(function* () {
              const reports = Context.get(context, TurnReports);
              const analytics = Context.get(context, CloudAnalytics.CloudAnalytics);
              yield* launch(engine, "launch-1", { ...personal, ...turn });
              const machine = yield* connect(runner);
              // The machine does get it, from the owner's object.
              expect((yield* runner.work).secrets).toEqual(environments);
              expect(yield* runner.secretsToken).toBe(TOKEN);

              const live = yield* liveTurn(runner);
              const report = turnReport(live.runId, live.runOrdinal, live.providerThread);
              const batch = (sequence: number, items: ReadonlyArray<RunnerItem>) =>
                runner.batch({ generation: machine.generation, sequence, items });
              yield* batch(1, [
                usage(live.runId, 10),
                report.started,
                {
                  kind: "secrets.notice",
                  runId: live.runId,
                  message: "Couldn't read env-work: the service account can't see it.",
                },
              ]);
              yield* batch(2, [
                { kind: "log", runId: live.runId, level: "info", message: "loaded 1 environment" },
                report.full,
                report.terminal,
              ]);
              yield* batch(3, [usage(live.runId, 14)]);
              // The idle tail starts once the turn is over.
              expect((yield* runner.reconcile).release).toBeNull();
              yield* TestClock.adjust(FINALIZE_GRACE_MS);
              yield* reports.finalize((yield* snapshot(engine)).projection, yield* nowMs);
              yield* TestClock.adjust(IDLE_TAIL_MS);
              expect((yield* runner.reconcile).drain?.generation).toBe(machine.generation);
              yield* TestClock.adjust(DRAIN_TIMEOUT_MS);
              expect((yield* runner.reconcile).release).toBe(machine.generation);
              yield* reports.finalize((yield* snapshot(engine)).projection, yield* nowMs);
              expect(yield* analytics.deliver).toBe(true);
              expect(sent.length).toBeGreaterThan(0);

              const { projection } = yield* snapshot(engine);
              const record = yield* reports.turn(projection, live.traceId);
              expect(record).not.toBeNull();
              expect(text_(projection)).toContain("Couldn't read env-work");
              for (const stored of [
                yield* dump(Context.get(context, SqlClient.SqlClient)),
                text_(projection),
                text_(record),
                text_(yield* reports.list(projection)),
                text_(sent),
              ]) {
                expect(stored).not.toContain(TOKEN);
              }
            }),
          {
            drives: true,
            analytics: layerPostHog(sent),
            secretsToken: (owner) => cloud.userDirectory.forUser(owner).onePasswordToken(),
          },
        );

        // The owner's object keeps it in its account row only, and shows clients when, not what.
        const userDb = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap((sql) =>
            Effect.all({
              others: dump(sql, ["onepassword_account"]),
              account: Effect.map(sql`SELECT token FROM onepassword_account`, text_),
            }),
          ),
          Effect.provide(cloud.userObject(userId)),
        );
        expect(userDb.account).toContain(TOKEN);
        expect(userDb.others).not.toContain(TOKEN);
        expect(text_(connected)).not.toContain(TOKEN);
        expect(text_(yield* folders.snapshot)).not.toContain(TOKEN);

        // Spans were seen (ids and counts), and neither they nor any log line hold the token.
        const turnSpan = watch.spans.find((span) => span.name === "UserFolders.turn");
        expect(turnSpan?.attributes.get("secrets.levels")).toBe(2);
        expect(watch.spans.some((span) => span.name === "UserFolders.setOnePassword")).toBe(true);
        expect(watch.text()).not.toContain(TOKEN);
      }).pipe(Effect.provide(watch.layer));
    },
  );

  it.effect(
    "serve a turn's model requests only once its machine registered the values, kept nowhere else",
    () => {
      const watch = observed();
      const environments = [OnePasswordEnvironmentId.make("env-top")];
      // Generated per run: no test holds a real secret.
      const value = `sk-fake-${crypto.randomUUID()}`;
      return withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          const register = (token: string, body: string) =>
            serveSessionRequest({
              method: "POST",
              url: `http://cloud.test${SESSION_PATHS.secrets}`,
              token,
              body,
            }).pipe(Effect.provide(context));
          yield* launch(engine, "launch-1", {
            ...personal,
            secrets: { top: environments, projects: {} },
          });
          yield* connect(runner);
          const work = yield* runner.work;
          const modelToken = work.modelToken ?? "";
          const sessionToken = work.sessions?.token ?? "";
          expect(work.secrets).toEqual(environments);

          // Before the machine says what to hide, the provider gets nothing.
          expect(yield* runner.authorizeModel(modelToken, "anthropic")).toMatchObject({
            _tag: "unregistered",
            reason: "This machine hasn't registered the folder's secrets to hide them yet.",
          });
          // Only the machine holding the lease may register, and only readable lists.
          const body = JSON.stringify({ secrets: [{ name: "FAKE_SECRET", value }] });
          expect((yield* register(`${sessionToken}x`, body)).status).toBe(403);
          const unreadable = JSON.stringify({ secrets: [{ name: "not a name", value }] });
          expect((yield* register(sessionToken, unreadable)).status).toBe(400);
          expect((yield* register(sessionToken, body)).status).toBe(200);

          expect(yield* runner.authorizeModel(modelToken, "anthropic")).toMatchObject({
            _tag: "granted",
            secrets: [{ name: "FAKE_SECRET", value }],
          });
          // Values only join: a later load without it still hides it.
          expect((yield* register(sessionToken, JSON.stringify({ secrets: [] }))).status).toBe(200);
          expect(yield* runner.authorizeModel(modelToken, "anthropic")).toMatchObject({
            secrets: [{ name: "FAKE_SECRET", value }],
          });

          const { projection } = yield* snapshot(engine);
          for (const stored of [
            yield* dump(Context.get(context, SqlClient.SqlClient), ["secret_values"]),
            text_(projection),
            watch.text(),
          ]) {
            expect(stored).not.toContain(value);
          }
        }),
      ).pipe(Effect.provide(watch.layer));
    },
  );
});
