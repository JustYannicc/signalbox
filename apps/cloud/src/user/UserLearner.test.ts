import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { learnerTool } from "./learnerTool.ts";

const COMPANY = SignalboxContextId.make("org_acme");
const root = ThreadId.make("root");
const project = ThreadId.make("project");
const sibling = ThreadId.make("sibling");
const company = ThreadId.make("company");
const layersWith = (judge: Layer.Layer<LearnerJev.LearnerJev>) =>
  UserLearner.layer.pipe(
    Layer.provideMerge(LearnerHomes.layer),
    Layer.provideMerge(LearnerService.layer.pipe(Layer.provide(judge))),
    Layer.provide(LearnerSummary.layerNone),
    Layer.provideMerge(layerMemoryStore),
  );
const layers = layersWith(LearnerJev.layerNone);
const pairedLayers = layersWith(
  Layer.effect(
    LearnerJev.LearnerJev,
    Effect.map(LearnerJev.LearnerJev, (judge) => ({
      ...judge,
      classifyPair: () => Effect.succeedSome("confirmed" as const),
    })),
  ).pipe(Layer.provide(LearnerJev.layerNone)),
);

const setup = Effect.gen(function* () {
  yield* (yield* UserStore.UserStore).recordSignIn({ id: "user_a", email: "a@example.com" });
  yield* (yield* UserContexts.UserContexts).syncOrganizations([{ id: COMPANY, name: "Acme" }]);
  const sql = yield* SqlClient.SqlClient;
  for (const [id, contextId] of [
    [root, PERSONAL_CONTEXT_ID],
    [project, PERSONAL_CONTEXT_ID],
    [sibling, PERSONAL_CONTEXT_ID],
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
  it.effect("pairs two threads' decisions independently when their local event IDs match", () =>
    Effect.gen(function* () {
      const { folderId } = yield* setup;
      yield* (yield* UserFolders.UserFolders).moveThread({ threadId: sibling, folderId });
      const precedentIds = new Set<string>();
      for (const thread of [project, sibling]) {
        yield* learnerTool(thread, "learner_log_event", {
          eventId: "draft-1",
          source: "review",
          kind: "draft",
          content: `Draft for ${thread}`,
          objectId: `review:${thread}`,
        });
        const action = {
          eventId: "action-1",
          source: "review",
          kind: "human_action",
          content: `Action for ${thread}`,
          objectId: `review:${thread}`,
        };
        const result = yield* learnerTool(thread, "learner_log_event", action);
        expect(result).toMatchObject({
          _tag: "ok",
          result: { eventId: action.eventId, stored: true, paired: true },
        });
        expect(yield* learnerTool(thread, "learner_log_event", action)).toMatchObject({
          _tag: "ok",
          result: { stored: false, paired: true },
        });
      }
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        id: string;
        draft: string;
        action: string;
      }>`SELECT id, draft, action
        FROM sbx_level_learner_668_precedents ORDER BY action`;
      expect(rows.map(({ draft, action }) => ({ draft, action }))).toEqual([
        { draft: `Draft for ${project}`, action: `Action for ${project}` },
        { draft: `Draft for ${sibling}`, action: `Action for ${sibling}` },
      ]);
      for (const row of rows) precedentIds.add(row.id);
      expect(precedentIds.size).toBe(2);
    }).pipe(Effect.provide(pairedLayers)),
  );

  it.effect("keeps tool event IDs separate across threads and stable after a move", () =>
    Effect.gen(function* () {
      const { homes, folderId } = yield* setup;
      const folders = yield* UserFolders.UserFolders;
      yield* folders.moveThread({ threadId: sibling, folderId });
      const original = yield* homes.home(project);
      const event = {
        eventId: "draft-1",
        source: "review",
        kind: "draft",
        content: "Keep this decision.",
      };
      for (const thread of [project, sibling, root]) {
        const result = yield* learnerTool(thread, "learner_log_event", event);
        expect(result).toMatchObject({ _tag: "ok", result: { stored: true, paired: false } });
      }
      expect(yield* learnerTool(project, "learner_log_event", event)).toMatchObject({
        _tag: "ok",
        result: { stored: false, paired: false },
      });
      yield* folders.moveThread({ threadId: project, folderId: null });
      expect(yield* learnerTool(project, "learner_log_event", event)).toMatchObject({
        _tag: "ok",
        result: { stored: false, paired: false },
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ event_id: string; scope: string }>`SELECT event_id, scope
        FROM sbx_level_learner_668_events ORDER BY event_id`;
      expect(rows).toEqual([
        { event_id: JSON.stringify(["tool", project, event.eventId]), scope: original.scope },
        {
          event_id: JSON.stringify(["tool", root, event.eventId]),
          scope: (yield* homes.home(root)).scope,
        },
        { event_id: JSON.stringify(["tool", sibling, event.eventId]), scope: original.scope },
      ]);
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

  it.effect("keeps owner statements at their personal level", () =>
    Effect.gen(function* () {
      const { learner, folderId } = yield* setup;
      yield* learner.statement(root, { text: "Private preference", reason: "Owner statement" });
      yield* learner.statement(project, { text: "Project preference", reason: "Owner statement" });
      expect((yield* learner.lenses(root, {})).lenses.map((lens) => lens.text)).toEqual([
        "Private preference",
      ]);
      expect((yield* learner.lenses(root, { folderId })).lenses.map((lens) => lens.text)).toEqual([
        "Project preference",
      ]);
      expect((yield* learner.lenses(project, {})).lenses.map((lens) => lens.text)).toEqual([
        "Project preference",
      ]);
    }).pipe(Effect.provide(layers)),
  );

  it.effect("refuses every company learner operation", () =>
    Effect.gen(function* () {
      const { learner } = yield* setup;
      const event = {
        eventId: "company-draft",
        source: "thread",
        kind: "draft" as const,
        content: "Company decision",
      };
      for (const attempt of [
        learner.log(company, event).pipe(Effect.asVoid),
        learner
          .statement(company, { text: "Company rule", reason: "Owner statement" })
          .pipe(Effect.asVoid),
        learner.query(company, "Company decision").pipe(Effect.asVoid),
        learner.lenses(company, {}).pipe(Effect.asVoid),
      ]) {
        const failure = yield* Effect.flip(attempt);
        expect(failure._tag).toBe("LearnerAccessError");
        if (failure._tag === "LearnerAccessError")
          expect(failure.reason).toBe("unsupported-company");
      }
      yield* learner.query(root, "No personal evidence");
      const sql = yield* SqlClient.SqlClient;
      const events = yield* sql`SELECT event_id FROM sbx_level_learner_668_events`;
      const lenses = yield* sql`SELECT id FROM sbx_level_learner_668_lenses`;
      expect(events).toEqual([]);
      expect(lenses).toEqual([]);
    }).pipe(Effect.provide(layers)),
  );
});
