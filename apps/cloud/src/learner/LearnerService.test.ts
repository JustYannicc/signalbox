import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as LearnerJev from "./LearnerJev.ts";
import * as LearnerService from "./LearnerService.ts";

type JevOptions = {
  classify?: (
    question: LearnerJev.PairQuestion,
  ) => Option.Option<"confirmed" | "countermanded" | "overridden" | "ambiguous">;
  match?: (
    candidates: ReadonlyArray<LearnerJev.DraftCandidate>,
  ) => Option.Option<{ readonly eventId: string; readonly confidence: number }>;
  relevance?: (
    candidates: ReadonlyArray<LearnerJev.LensCandidate>,
  ) => ReadonlyArray<{ readonly lensId: string; readonly probability: number }>;
  outcome?: () => Option.Option<"support" | "miss">;
  coverage?: () => Option.Option<"clear" | "contradiction">;
  onRelevance?: (input: {
    readonly task: string;
    readonly candidates: ReadonlyArray<LearnerJev.LensCandidate>;
  }) => void;
};

const fakeJev = (options: JevOptions = {}) => {
  const service: LearnerJev.LearnerJev["Service"] = {
    summarySafe: () => Effect.succeed(false),
    classifyPair: (question: LearnerJev.PairQuestion) =>
      Effect.succeed(options.classify?.(question) ?? Option.some("confirmed")),
    matchDraft: ({ candidates }: { candidates: ReadonlyArray<LearnerJev.DraftCandidate> }) =>
      Effect.succeed(
        options.match?.(candidates) ??
          (candidates[0]
            ? Option.some({ eventId: candidates[0].eventId, confidence: 0.99 })
            : Option.none()),
      ),
    relevance: (input: {
      readonly task: string;
      readonly candidates: ReadonlyArray<LearnerJev.LensCandidate>;
    }) => {
      options.onRelevance?.(input);
      return Effect.succeed(
        options.relevance?.(input.candidates) ??
          input.candidates.map(({ id }) => ({ lensId: id, probability: 0.99 })),
      );
    },
    outcome: () => Effect.succeed(options.outcome?.() ?? Option.none()),
    coverage: () => Effect.succeed(options.coverage?.() ?? Option.some("clear")),
  };
  return LearnerJev.LearnerJev.of(service);
};

const layerFor = (jev: LearnerJev.LearnerJev["Service"]) =>
  LearnerService.layer.pipe(
    Layer.provideMerge(Layer.succeed(LearnerJev.LearnerJev, jev)),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

const log = (
  service: LearnerService.LearnerService["Service"],
  event: {
    eventId: string;
    treeId?: string;
    source?: string;
    kind: "observation" | "draft" | "human_action";
    content: string;
    input?: string;
    objectId?: string;
    usedLensId?: string;
  },
  scope = "person",
) =>
  service.logEvent({
    scope,
    event: {
      treeId: event.treeId ?? "tree-person",
      source: event.source ?? "thread",
      ...event,
    },
  });

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_events`;
  const precedents = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_precedents`;
  const lenses = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_lenses`;
  return {
    events: events[0]?.count ?? 0,
    precedents: precedents[0]?.count ?? 0,
    lenses: lenses[0]?.count ?? 0,
  };
});

describe("level learner service", () => {
  it.effect("pairs decisions from different sources and keeps all four human outcomes", () =>
    Effect.gen(function* () {
      const outcomes = ["confirmed", "countermanded", "overridden", "ambiguous"] as const;
      const service = yield* LearnerService.LearnerService;
      for (const [index, classification] of outcomes.entries()) {
        const objectId = `object-${index}`;
        yield* log(service, {
          eventId: `draft-${index}`,
          source: index % 2 === 0 ? "github" : "linear",
          kind: "draft",
          content: `draft ${index}`,
          input: `task ${index}`,
          objectId,
        });
        yield* log(service, {
          eventId: `action-${index}`,
          source: index % 2 === 0 ? "github" : "linear",
          kind: "human_action",
          content: `action ${index}`,
          objectId,
        });
        expect(classification).toBe(outcomes[index]);
      }
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        classification: string;
        source: string;
      }>`SELECT classification, source
        FROM sbx_level_learner_668_precedents ORDER BY action_event_id`;
      expect(rows.map((row) => row.classification)).toEqual([
        "confirmed",
        "countermanded",
        "overridden",
        "ambiguous",
      ]);
      expect(new Set(rows.map((row) => row.source))).toEqual(
        new Set(["github → github", "linear → linear"]),
      );
      expect(yield* counts).toEqual({ events: 8, precedents: 4, lenses: 3 });
    }).pipe(
      Effect.provide(
        layerFor(
          fakeJev({
            classify: ({ action }) => Option.some(outcomesForAction(action)),
          }),
        ),
      ),
    ),
  );

  it.effect("uses Jev only when object ids cannot pair and rejects an unreturned candidate", () =>
    Effect.gen(function* () {
      const service = yield* LearnerService.LearnerService;
      yield* log(service, {
        eventId: "draft-a",
        kind: "draft",
        content: "Use the deployment plan",
        input: "Deploy safely",
      });
      const valid = yield* log(service, {
        eventId: "action-a",
        kind: "human_action",
        content: "Use the deployment plan",
        input: "Deploy safely",
      });
      expect(valid.paired).toBe(true);
      yield* log(service, {
        eventId: "draft-b",
        kind: "draft",
        content: "Send the announcement",
        input: "Announce release",
      });
      const invalid = yield* log(service, {
        eventId: "action-b",
        kind: "human_action",
        content: "Send the announcement",
        input: "Announce release",
      });
      expect(invalid.paired).toBe(false);
      expect(yield* counts).toMatchObject({ events: 4, precedents: 1 });
    }).pipe(
      Effect.provide(
        layerFor(
          fakeJev({
            match: (candidates) =>
              candidates[0]?.eventId === "draft-a"
                ? Option.some({ eventId: "draft-a", confidence: 0.99 })
                : Option.some({ eventId: "not-a-candidate", confidence: 0.99 }),
          }),
        ),
      ),
    ),
  );

  it.effect("keeps personal, folder and company prompts inside their own scopes", () => {
    const prompts: Array<{ task: string; texts: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const service = yield* LearnerService.LearnerService;
      yield* service.addStatement({
        scope: "person",
        treeId: "person-tree",
        text: "Private rule",
        reason: "private",
      });
      yield* service.addStatement({
        scope: "folder",
        treeId: "folder-tree",
        text: "Project rule",
        reason: "project",
      });
      yield* service.addStatement({
        scope: "company",
        treeId: "company-tree",
        text: "Company rule",
        reason: "company",
      });
      for (const [scope, text] of [
        ["person", "Private rule"],
        ["folder", "Project rule"],
        ["company", "Company rule"],
      ] as const) {
        const result = yield* service.query({ scope, task: "What should I do?" });
        expect(result.lenses.map((lens) => lens.text)).toEqual([text]);
      }
      expect(prompts.map((prompt) => prompt.texts)).toEqual([
        ["Private rule"],
        [],
        ["Project rule"],
        [],
        ["Company rule"],
        [],
      ]);
    }).pipe(
      Effect.provide(
        layerFor(
          fakeJev({
            onRelevance: ({ task, candidates }) => {
              prompts.push({ task, texts: candidates.map((candidate) => candidate.text) });
            },
          }),
        ),
      ),
    );
  });

  it.effect(
    "keeps unborne seed lenses out of lower summaries until later support, and applies owner priors",
    () =>
      Effect.gen(function* () {
        const service = yield* LearnerService.LearnerService;
        const sql = yield* SqlClient.SqlClient;

        yield* log(service, {
          eventId: "learned-draft-1",
          kind: "draft",
          content: "Stage the deploy first",
          input: "Deploy safely",
          objectId: "learned-object-1",
        });
        yield* log(service, {
          eventId: "learned-action-1",
          kind: "human_action",
          content: "Stage the deploy first",
          objectId: "learned-object-1",
        });
        expect((yield* service.lenses({ scope: "person" })).lenses).toEqual([]);

        const learned = yield* sql<{ id: string }>`SELECT id FROM sbx_level_learner_668_lenses
        WHERE scope = 'person' AND text = 'When the task is like: Deploy safely Choose: Stage the deploy first'`;
        expect(learned).toHaveLength(1);
        yield* log(service, {
          eventId: "learned-draft-2",
          kind: "draft",
          content: "Stage the deploy first",
          input: "Deploy safely",
          objectId: "learned-object-2",
          usedLensId: learned[0]!.id,
        });
        yield* log(service, {
          eventId: "learned-action-2",
          kind: "human_action",
          content: "Stage the deploy first",
          objectId: "learned-object-2",
        });
        const summaries = yield* service.lenses({ scope: "person" });
        expect(summaries.lenses).toHaveLength(1);
        expect(summaries.lenses[0]).toMatchObject({
          text: "When the task is like: Deploy safely Choose: Stage the deploy first",
          supports: 1,
          hitRate: 1,
        });
        expect((yield* service.query({ scope: "person", task: "Deploy safely" })).answerAlone).toBe(
          true,
        );

        const owner = yield* service.addStatement({
          scope: "owner-scope",
          treeId: "tree-owner",
          text: "Only merge after checks pass",
          reason: "The owner stated this rule.",
        });
        expect(owner).toMatchObject({ ownerStated: true, supports: 3, misses: 0, hitRate: 1 });
        const ownerRows = yield* sql<{ id: string }>`SELECT id FROM sbx_level_learner_668_lenses
        WHERE scope = 'owner-scope' AND text = 'Only merge after checks pass'`;
        yield* log(
          service,
          {
            eventId: "owner-draft",
            treeId: "tree-owner",
            kind: "draft",
            content: "Merge now",
            input: "Merge this PR",
            objectId: "owner-object",
            usedLensId: ownerRows[0]!.id,
          },
          "owner-scope",
        );
        yield* log(
          service,
          {
            eventId: "owner-action",
            treeId: "tree-owner",
            kind: "human_action",
            content: "Do not merge yet",
            objectId: "owner-object",
          },
          "owner-scope",
        );
        expect((yield* service.lenses({ scope: "owner-scope" })).lenses).toEqual([]);
        expect(
          (yield* service.query({ scope: "owner-scope", task: "Merge this PR" })).answerAlone,
        ).toBe(false);
      }).pipe(
        Effect.provide(
          layerFor(
            fakeJev({
              classify: ({ action }) =>
                Option.some(action === "Do not merge yet" ? "countermanded" : "confirmed"),
            }),
          ),
        ),
      ),
  );

  it.effect(
    "a retried older decision cannot validate a newer lens, even with equal timestamps",
    () => {
      let classifyOlder = false;
      return Effect.gen(function* () {
        const service = yield* LearnerService.LearnerService;
        for (const [prefix, content] of [
          ["older", "Earlier decision: wait for checks"],
          ["seed", "Wait for checks"],
        ] as const) {
          yield* log(service, {
            eventId: `${prefix}-draft`,
            kind: "draft",
            input: "Release safely",
            content,
            objectId: prefix,
          });
          yield* log(service, {
            eventId: `${prefix}-action`,
            kind: "human_action",
            content,
            objectId: prefix,
          });
        }
        classifyOlder = true;
        const retried = yield* service.query({ scope: "person", task: "Release safely" });
        expect(retried.precedents).toHaveLength(2);
        expect(retried.lenses).toHaveLength(1);
        expect(retried.lenses[0]).toMatchObject({ supports: 0, misses: 0, served: false });
        expect(retried.answerAlone).toBe(false);
        expect((yield* service.lenses({ scope: "person" })).lenses).toEqual([]);

        yield* log(service, {
          eventId: "later-draft",
          kind: "draft",
          input: "Release safely",
          content: "Wait for checks",
          objectId: "later",
        });
        yield* log(service, {
          eventId: "later-action",
          kind: "human_action",
          content: "Wait for checks",
          objectId: "later",
        });
        const validated = yield* service.query({ scope: "person", task: "Release safely" });
        expect(validated.lenses).toHaveLength(1);
        expect(validated.lenses[0]).toMatchObject({ supports: 1, served: true });
        expect(validated.answerAlone).toBe(true);
      }).pipe(
        Effect.provide(
          layerFor(
            fakeJev({
              classify: ({ action }) =>
                action.startsWith("Earlier") && !classifyOlder
                  ? Option.none()
                  : Option.some("confirmed"),
              outcome: () => Option.some("support"),
            }),
          ),
        ),
      );
    },
  );

  it.effect("requires Jev to establish clear coverage before answering alone", () => {
    let coverage: Option.Option<"clear" | "contradiction"> = Option.none();
    return Effect.gen(function* () {
      const service = yield* LearnerService.LearnerService;
      yield* service.addStatement({
        scope: "person",
        treeId: "tree-person",
        text: "Only merge after checks pass",
        reason: "The owner stated this rule.",
      });
      expect((yield* service.query({ scope: "person", task: "Merge this PR" })).answerAlone).toBe(
        false,
      );
      coverage = Option.some("contradiction");
      expect((yield* service.query({ scope: "person", task: "Merge this PR" })).answerAlone).toBe(
        false,
      );
      coverage = Option.some("clear");
      const answer = yield* service.query({ scope: "person", task: "Merge this PR" });
      expect(answer.answerAlone).toBe(true);
      expect(answer.usedLensId).not.toBeNull();
    }).pipe(
      Effect.provide(
        layerFor(
          fakeJev({
            coverage: () => coverage,
          }),
        ),
      ),
    );
  });

  it.effect("retries an unpaired action on replay after Jev recovers without duplicating it", () =>
    Effect.gen(function* () {
      const service = yield* LearnerService.LearnerService;
      yield* log(service, {
        eventId: "retry-draft",
        kind: "draft",
        content: "Run checks",
        input: "Prepare release",
        objectId: "retry-object",
      });
      const first = yield* log(service, {
        eventId: "retry-action",
        kind: "human_action",
        content: "Run checks",
        objectId: "retry-object",
      });
      expect(first.paired).toBe(false);
      const replay = yield* log(service, {
        eventId: "retry-action",
        kind: "human_action",
        content: "Run checks",
        objectId: "retry-object",
      });
      expect(replay).toMatchObject({ stored: false, paired: true });
      expect(yield* counts).toMatchObject({ events: 2, precedents: 1 });
    }).pipe(
      Effect.provide(
        layerFor(
          fakeJev({
            classify: (() => {
              let calls = 0;
              return () => (++calls === 1 ? Option.none() : Option.some("confirmed"));
            })(),
          }),
        ),
      ),
    ),
  );

  it.effect("validates settings and revokes a tree's source and learned rows", () =>
    Effect.gen(function* () {
      const service = yield* LearnerService.LearnerService;
      const valid = {
        minLaterSupports: 1,
        minHitRate: 0.8,
        halfLifeMs: 1000,
        relevanceThreshold: 0.55,
      };
      for (const settings of [
        { ...valid, minLaterSupports: -1 },
        { ...valid, minHitRate: 1.1 },
        { ...valid, halfLifeMs: 0 },
        { ...valid, relevanceThreshold: -0.1 },
      ]) {
        expect(
          (yield* Effect.flip(service.setSettings({ scope: "person", treeId: "tree-a", settings })))
            ._tag,
        ).toBe("LearnerSettingsError");
      }
      yield* service.setSettings({ scope: "person", treeId: "tree-a", settings: valid });
      yield* service.addStatement({
        scope: "person",
        treeId: "tree-a",
        text: "Tree A rule",
        reason: "stated",
      });
      yield* service.addStatement({
        scope: "company",
        treeId: "tree-b",
        text: "Tree B rule",
        reason: "stated",
      });
      yield* log(service, {
        eventId: "tree-a-event",
        treeId: "tree-a",
        kind: "observation",
        content: "private evidence",
      });
      yield* log(
        service,
        {
          eventId: "tree-b-event",
          treeId: "tree-b",
          kind: "observation",
          content: "company evidence",
        },
        "company",
      );
      yield* service.revokeTree("tree-a");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        scope: string;
        text: string;
      }>`SELECT scope, text FROM sbx_level_learner_668_lenses ORDER BY scope`;
      expect(rows).toEqual([{ scope: "company", text: "Tree B rule" }]);
      expect(yield* counts).toMatchObject({ events: 1, precedents: 0, lenses: 1 });
      const settingsRows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_settings`;
      expect(settingsRows[0]?.count).toBe(0);
    }).pipe(Effect.provide(layerFor(fakeJev()))),
  );
});

const outcomesForAction = (
  action: string,
): "confirmed" | "countermanded" | "overridden" | "ambiguous" => {
  switch (action) {
    case "action 1":
      return "countermanded";
    case "action 2":
      return "overridden";
    case "action 3":
      return "ambiguous";
    default:
      return "confirmed";
  }
};
