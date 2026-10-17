import { EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment.ts";
import * as LearnerJev from "../learner/LearnerJev.ts";
import * as LearnerService from "../learner/LearnerService.ts";
import * as LearnerSummary from "../learner/LearnerSummary.ts";
import { layerMemoryStore } from "../testing.ts";
import * as LearnerHomes from "./LearnerHomes.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserLearner from "./UserLearner.ts";
import * as UserStore from "./UserStore.ts";

const COMPANY = SignalboxContextId.make("org_acme");
const root = ThreadId.make("root");
const project = ThreadId.make("project");
const company = ThreadId.make("company");
const layersWith = (judge: Layer.Layer<LearnerJev.LearnerJev>) =>
  UserLearner.layer.pipe(
    Layer.provideMerge(LearnerHomes.layer),
    Layer.provideMerge(LearnerService.layer.pipe(Layer.provide(judge))),
    Layer.provide(LearnerSummary.layerNone),
    Layer.provideMerge(layerMemoryStore),
  );
const layers = layersWith(LearnerJev.layerNone);

const setup = Effect.gen(function* () {
  yield* (yield* UserStore.UserStore).recordSignIn({ id: "user_a", email: "a@example.com" });
  yield* (yield* UserContexts.UserContexts).syncOrganizations([{ id: COMPANY, name: "Acme" }]);
  const sql = yield* SqlClient.SqlClient;
  for (const [id, contextId] of [
    [root, PERSONAL_CONTEXT_ID],
    [project, PERSONAL_CONTEXT_ID],
    [company, COMPANY],
  ] as const) {
    yield* sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
      VALUES (${id}, ${contextId}, 1, ${JSON.stringify({ projectId: Environment.SCRATCH_PROJECT_ID })}, 0)`;
  }
  const folders = yield* UserFolders.UserFolders;
  const snapshot = yield* folders.create({ name: "Project", parentId: null });
  const folderId = snapshot.folders[0]!.id;
  yield* sql`INSERT INTO thread_homes (thread_id, folder_id, filed_at) VALUES (${project}, ${folderId}, 0)`;
  return {
    learner: yield* UserLearner.UserLearner,
    homes: yield* LearnerHomes.LearnerHomes,
    folderId,
  };
});

describe("user learner", () => {
  it.effect("refuses an in-flight query if its membership was revoked while Jev answered", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const judge = LearnerJev.LearnerJev.of({
        classifyPair: () => Effect.succeedNone,
        matchDraft: () => Effect.succeedNone,
        relevance: ({ candidates }) =>
          Effect.succeed(candidates.map((lens) => ({ lensId: lens.id, probability: 0.99 }))),
        outcome: () => Effect.succeedNone,
        summarySafe: () => Effect.succeed(false),
        coverage: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return Option.some("clear" as const);
          }),
      });
      yield* Effect.gen(function* () {
        const { learner } = yield* setup;
        yield* learner.statement(company, {
          text: "Company-only rule",
          reason: "The owner stated it.",
        });
        const query = yield* Effect.forkChild(
          Effect.flip(learner.query(company, "Company decision")),
        );
        yield* Deferred.await(started);
        yield* (yield* UserContexts.UserContexts).syncOrganizations([]);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(query))._tag).toBe("LearnerAccessError");
      }).pipe(Effect.provide(layersWith(Layer.succeed(LearnerJev.LearnerJev, judge))));
    }),
  );

  it.effect(
    "takes committed thread events once at their home without teaching from conversation alone",
    () =>
      Effect.gen(function* () {
        const { learner, homes } = yield* setup;
        const eventId = EventId.make("thread-event-1");
        const at = DateTime.makeUnsafe(0);
        yield* learner.observe(project, [
          {
            sequence: 1,
            event: {
              id: eventId,
              threadId: project,
              type: "message.updated",
              occurredAt: at,
              payload: {
                id: MessageId.make("message-1"),
                threadId: project,
                runId: null,
                nodeId: null,
                role: "user",
                text: "Keep the deploy reversible.",
                createdAt: at,
                updatedAt: at,
                createdBy: "user",
                creationSource: "web",
                streaming: false,
                attachments: [],
              },
            },
          },
        ]);
        const home = yield* homes.home(project);
        const core = yield* LearnerService.LearnerService;
        const retried = yield* core.logEvent({
          scope: home.scope,
          event: {
            eventId: `thread:${project}:${eventId}`,
            treeId: home.treeId,
            source: "thread",
            kind: "observation",
            content: "Same delivery",
          },
        });
        expect(retried.stored).toBe(false);
        expect((yield* learner.query(project, "deploy")).precedents).toEqual([]);
        expect((yield* learner.query(root, "deploy")).precedents).toEqual([]);
      }).pipe(Effect.provide(layers)),
  );

  it.effect("keeps an event at its original home when a moved thread retries delivery", () =>
    Effect.gen(function* () {
      const { learner, homes } = yield* setup;
      const before = yield* homes.home(project);
      const event = {
        eventId: "connected-source:decision-1",
        source: "connected-source",
        kind: "observation" as const,
        content: "Evidence belongs to the original folder.",
      };
      expect((yield* learner.log(project, event)).stored).toBe(true);
      yield* (yield* UserFolders.UserFolders).moveThread({ threadId: project, folderId: null });
      const after = yield* homes.home(project);
      expect(after.scope).not.toBe(before.scope);
      expect((yield* learner.log(project, event)).stored).toBe(false);
      expect(
        (yield* learner.log(project, { ...event, eventId: "connected-source:decision-2" })).stored,
      ).toBe(true);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ event_id: string; scope: string }>`SELECT event_id, scope
          FROM sbx_level_learner_668_events ORDER BY event_id`;
      expect(rows).toEqual([
        { event_id: event.eventId, scope: before.scope },
        { event_id: "connected-source:decision-2", scope: after.scope },
      ]);
    }).pipe(Effect.provide(layers)),
  );

  it.effect(
    "keeps owner statements per level and deletes company contributions on membership revocation",
    () =>
      Effect.gen(function* () {
        const { learner, homes, folderId } = yield* setup;
        for (const [id, text] of [
          [root, "Private preference"],
          [project, "Project preference"],
          [company, "Company preference"],
        ] as const) {
          yield* learner.statement(id, { text, reason: "The owner stated this." });
        }
        expect((yield* learner.lenses(root, {})).lenses.map((lens) => lens.text)).toEqual([
          "Private preference",
        ]);
        expect((yield* learner.lenses(root, { folderId })).lenses.map((lens) => lens.text)).toEqual(
          ["Project preference"],
        );
        expect((yield* learner.lenses(project, {})).lenses.map((lens) => lens.text)).toEqual([
          "Project preference",
        ]);
        const companyHome = yield* homes.home(company);
        yield* (yield* UserContexts.UserContexts).syncOrganizations([]);
        expect(
          (yield* (yield* LearnerService.LearnerService).lenses({ scope: companyHome.scope }))
            .lenses,
        ).toEqual([]);
        expect((yield* learner.lenses(root, {})).lenses).toHaveLength(1);
        expect((yield* Effect.flip(learner.query(company, "Company preference")))._tag).toBe(
          "LearnerAccessError",
        );
        yield* (yield* UserContexts.UserContexts).syncOrganizations([
          { id: COMPANY, name: "Acme" },
        ]);
        expect((yield* learner.lenses(company, {})).lenses).toEqual([]);
        yield* learner.statement(company, {
          text: "A fresh company rule",
          reason: "Stated after rejoining.",
        });
        expect((yield* learner.lenses(company, {})).lenses.map((lens) => lens.text)).toEqual([
          "A fresh company rule",
        ]);
      }).pipe(Effect.provide(layers)),
  );
});
