import { CommandId } from "@t3tools/contracts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerAttachments, layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as Platform from "../platform.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import { saveSecretSources } from "./secretRegistrationTesting.ts";
import { runtimeResponseEvents } from "./runtimeResponses.ts";
import * as ThreadSends from "./ThreadSends.ts";
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
} from "./runnerTesting.ts";

const host = "hooks.example.test";
const environment = OnePasswordEnvironmentId.make("envfolder");

describe("cloud approval ownership on the canonical answer route", () => {
  it.effect(
    "rejects assistant ask answers and preserves person-only send and Always decisions",
    () =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started],
          });
          yield* saveSecretSources([{ name: "KEY", environment }]).pipe(
            Effect.provideService(SqlClient.SqlClient, Context.get(context, SqlClient.SqlClient)),
          );
          const kept: Array<{ environmentId: string; name: string; host: string }> = [];
          const cloud = makeMemoryCloud();
          const base = cloud.userDirectory;
          const users = UserDirectory.of({
            ...base,
            forUser: (id) => ({
              ...base.forUser(id),
              secretSendFolder: () => Effect.succeed(null),
              secretSendsAllowed: ({ host: destination, sends }) =>
                Effect.sync(() =>
                  sends
                    .filter((send) =>
                      kept.some(
                        (grant) =>
                          grant.environmentId === send.environmentId &&
                          grant.name === send.name &&
                          grant.host === destination,
                      ),
                    )
                    .map((send) => send.name),
                ),
              keepSecretSends: ({ grants }) =>
                Effect.sync(() => {
                  kept.push(...grants);
                }),
            }),
          });
          const service = yield* Threads.Threads.pipe(
            Effect.provide(
              ThreadsLive.layer.pipe(
                Layer.provide(
                  Layer.succeed(ThreadDirectory.ThreadDirectory, {
                    forThread: (id) => ({
                      ...cloud.threadDirectory.forThread(id),
                      dispatch: engine.dispatch,
                      snapshot: engine.snapshot,
                      workspace: engine.workspace,
                    }),
                  }),
                ),
                Layer.provide(layerPersonalThreadContexts(owner.userId)),
                Layer.provide(Platform.layerCrypto),
                Layer.provide(layerAttachments(makeMemoryObjects())),
              ),
            ),
          );
          yield* ThreadSends.ThreadSends.use((sends) =>
            Effect.gen(function* () {
              expect((yield* sends.authorize({ host, names: ["KEY"], waitMs: 0 }))._tag).toBe(
                "waiting",
              );
              const pending = (yield* snapshot(engine)).projection;
              const request = pending.runtimeRequests.find((entry) => entry.status === "pending");
              if (request === undefined) throw new Error("Expected a cloud approval.");
              // Cloud approvals aren't native questions and have no automatic durable ask mirror.
              expect(pending.thread.asks ?? []).toEqual([]);
              const response = {
                type: "runtime-request.respond" as const,
                commandId: CommandId.make("assistant-direct"),
                threadId,
                requestId: request.id,
                decision: "acceptAlways" as const,
              };
              expect(
                runtimeResponseEvents(
                  pending,
                  response,
                  { now: pending.updatedAt },
                  () => ({ _tag: "rejected", message: "Unexpected message delivery." }),
                  { kind: "assistant", personId: owner.userId },
                ),
              ).toMatchObject({ _tag: "rejected" });
              yield* engine.dispatch(
                owner,
                {
                  type: "thread.ask.raise",
                  commandId: CommandId.make("raise-cloud-mirror"),
                  threadId,
                  askId: "cloud-mirror",
                  ask: {
                    kind: "blocker",
                    source: { kind: "native", requestId: request.id },
                    questions: [
                      {
                        id: "approval",
                        question: "Send KEY?",
                        why: "An agent wants to send it.",
                        unblocks: "The request.",
                        recommendation: "decline",
                        options: [],
                        blocking: true,
                        decisionOwner: owner.userId,
                        surface: { kind: "kit", component: "text" },
                      },
                    ],
                  },
                },
                personal,
              );
              const seeded = (yield* snapshot(engine)).projection.thread.asks?.[0];
              if (seeded === undefined) throw new Error("Expected the internal adversarial ask.");
              // Public clients cannot claim native provenance for an agent-authored ask.
              yield* service.dispatch(owner, {
                type: "thread.ask.raise",
                commandId: CommandId.make("public-cloud-mirror"),
                threadId,
                askId: "public-cloud-mirror",
                ask: { ...seeded, source: { kind: "native", requestId: request.id } },
              });
              expect((yield* snapshot(engine)).projection.thread.asks?.at(-1)?.source).toEqual({
                kind: "agent",
              });
              yield* service.answerAskAsAssistant(owner, threadId, {
                type: "thread.ask.answer",
                commandId: CommandId.make("public-assistant-answer"),
                threadId,
                askId: "public-cloud-mirror",
                round: 1,
                answers: [{ questionId: "approval", value: "acceptAlways" }],
                deferredQuestionIds: [],
                answeredBy: { kind: "person", personId: "spoofed-person" },
              });
              const publicAnswered = (yield* snapshot(engine)).projection;
              expect(publicAnswered.thread.asks?.at(-1)?.rounds[0]?.answers[0]?.answeredBy).toEqual(
                {
                  kind: "assistant",
                  personId: owner.userId,
                  assistantThreadId: threadId,
                },
              );
              expect(
                publicAnswered.runtimeRequests.find((entry) => entry.id === request.id),
              ).toMatchObject({
                status: "pending",
              });
              const beforeAnswer = (yield* snapshot(engine)).projection;
              const answered = yield* Effect.result(
                service.answerAskAsAssistant(owner, threadId, {
                  type: "thread.ask.answer",
                  commandId: CommandId.make("assistant-mirror-answer"),
                  threadId,
                  askId: "cloud-mirror",
                  round: 1,
                  answers: [{ questionId: "approval", value: "acceptAlways" }],
                  deferredQuestionIds: [],
                  answeredBy: { kind: "person", personId: "spoofed-person" },
                }),
              );
              expect(answered._tag).toBe("Failure");
              expect((yield* snapshot(engine)).projection).toEqual(beforeAnswer);
              yield* sends.settle;
              expect(kept).toEqual([]);
              expect((yield* sends.authorize({ host, names: ["KEY"], waitMs: 0 }))._tag).toBe(
                "waiting",
              );
              expect((yield* runner.work).runtimeResponses).toEqual([]);
              yield* service.dispatch(owner, {
                ...response,
                commandId: CommandId.make("person-direct"),
              });
              yield* sends.settle;
              expect(kept).toEqual([{ environmentId: environment, name: "KEY", host }]);
              expect((yield* sends.authorize({ host, names: ["KEY"], waitMs: 0 }))._tag).toBe(
                "allowed",
              );
              expect((yield* runner.work).runtimeResponses).toEqual([]);
              expect((yield* snapshot(engine)).projection.runtimeRequests).toMatchObject([
                { id: request.id, status: "resolved", decision: "acceptAlways" },
              ]);
            }),
          ).pipe(
            Effect.provide(
              ThreadSends.layer.pipe(
                Layer.provide(Layer.succeedContext(context)),
                Layer.provide(Layer.succeed(UserDirectory, users)),
              ),
            ),
          );
        }),
      ),
  );
});
