import {
  ProviderInstanceId,
  PullRequestOperationError,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { poolSourceId } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserModelSettings from "../user/UserModelSettings.ts";
import * as UserPools from "../user/UserPools.ts";
import * as PullRequestGuideGeneration from "./PullRequestGuideGeneration.ts";
import { makePullRequestGuideStore } from "./PullRequestGuideStore.ts";
import { makePullRequestReviewGuides, PullRequestGuideAlarm } from "./PullRequestReviewGuides.ts";
import { fixture, reference, storage } from "./pullRequestCollaborationTesting.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const selection = { instanceId: ProviderInstanceId.make("codex_hub_work"), model: "gpt-6.1-sol" };
const request = { ...reference, headSha: HEAD, operationId: "guide-1" };

const setup = Effect.gen(function* () {
  const base = yield* fixture;
  const sql = yield* SqlClient.SqlClient;
  const completions = yield* Queue.unbounded<void>();
  const state = {
    head: HEAD,
    allowed: true,
    enabled: true,
    servesModel: true,
    calls: 0,
    refreshes: 0,
    armed: [] as Array<number>,
    selections: [] as Array<
      Pick<
        PullRequestGuideGeneration.PullRequestGuideGenerationInput,
        "pool" | "modelSelection" | "instructions"
      >
    >,
    beforeGeneration: Effect.void as Effect.Effect<void>,
  };
  const folderState: UserFolders.FolderState = {
    contexts: [
      {
        id: PERSONAL_CONTEXT_ID,
        kind: "personal",
        name: "Personal",
        projectIds: [reference.projectId],
      },
    ],
    drives: [],
    revision: 0,
    onePasswordConnectedAt: null,
    githubLends: new Map(),
    tree: {
      folders: [],
      topInstructions: "Explain the accepted contract.",
      topSecrets: null,
      bindings: [{ level: { _tag: "top" }, poolId: "work", reach: "below" }],
      filed: new Map(),
      driveOfProject: () => null,
    },
  };
  const dependencies = Layer.mergeAll(
    base.dependencies,
    Layer.mock(UserFolders.UserFolders, { state: Effect.sync(() => folderState) }),
    Layer.mock(UserModelSettings.UserModelSettings, {
      snapshot: Effect.sync(() => ({
        ...UserModelSettings.EMPTY_MODEL_SETTINGS,
        reviewGuidesEnabled: state.enabled,
        reviewGuideModelSelection: selection,
        reviewGuideInstructions: "Keep it short.",
      })),
    }),
    Layer.mock(UserPools.UserPools, {
      state: () =>
        Effect.succeed([
          {
            pool: {
              id: "work",
              objectName: "user-1:work",
              name: "Work",
              personal: false,
              backing: { mode: "managed" },
            },
            source: {
              id: poolSourceId("work"),
              kind: "cliproxy",
              label: "Work",
              checkedAt: "2026-10-18T00:00:00.000Z",
              accounts: [],
            },
            models: state.servesModel
              ? [{ id: "gpt-6.1-sol", ownedBy: "openai", created: null }]
              : [],
            role: "admin",
            routing: null,
          },
        ]),
    }),
    Layer.mock(ModelCatalog.ModelCatalog, { initialSelection: () => Effect.succeed(selection) }),
    Layer.succeed(PullRequestGuideAlarm, {
      armBy: (at) =>
        Effect.sync(() => {
          state.armed.push(at);
        }),
    }),
    Layer.mock(PullRequestGuideGeneration.PullRequestGuideGeneration, {
      generate: (input) =>
        Effect.gen(function* () {
          state.calls += 1;
          state.selections.push(input);
          yield* state.beforeGeneration;
          return { revision: { baseSha: BASE, headSha: HEAD }, guide: { stops: [] } };
        }),
    }),
  );
  const detail = () =>
    state.allowed
      ? Effect.succeed({ number: reference.number, headSha: state.head } as PullRequestDetail)
      : Effect.fail(
          new PullRequestOperationError({
            operation: "detail",
            reason: "permission",
            detail: "Access removed.",
          }),
        );
  const make = makePullRequestReviewGuides({
    detail,
    activity: () =>
      Effect.succeed({
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        reviewThreads: [],
        commits: [],
      }),
    diff: () =>
      Effect.succeed({
        revision: { baseSha: BASE, headSha: HEAD },
        patch: "",
        truncated: false,
        nextCursor: null,
      }),
    invalidate: () =>
      Effect.gen(function* () {
        state.refreshes += 1;
        const [latest] = yield* sql<{ readonly status: string }>`
          SELECT status FROM pull_request_guide_jobs ORDER BY sequence DESC LIMIT 1`.pipe(
          Effect.orDie,
        );
        if (latest?.status === "finished" || latest?.status === "failed")
          yield* Queue.offer(completions, undefined);
      }),
  }).pipe(Effect.provide(dependencies));
  return { base, state, make, guides: yield* make, sql, completed: Queue.take(completions) };
});

describe("durable cloud review guides", () => {
  it.effect(
    "fails a missing explicit model on the folder pool without silently choosing another",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        f.state.servesModel = false;
        yield* f.guides.generateReviewGuide(request);
        yield* f.guides.wakeReviewGuides;
        yield* f.completed;
        expect(f.state.calls).toBe(0);
        expect((yield* f.guides.reviewGuide(reference)).run).toMatchObject({
          _tag: "Failed",
          detail: "The review guide model is unavailable on this folder's pool.",
        });
        f.state.enabled = false;
        expect(
          yield* f.guides
            .generateReviewGuide({ ...request, operationId: "disabled" })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "permission" });
      }).pipe(Effect.provide(storage)),
  );

  it.effect(
    "persists a queued request, deduplicates presses, and replays after reconstruction",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        expect((yield* f.guides.generateReviewGuide(request)).run?._tag).toBe("Running");
        const restarted = yield* f.make;
        yield* restarted.generateReviewGuide(request);
        yield* restarted.generateReviewGuide({ ...request, operationId: "other-device" });
        expect(f.state.calls).toBe(0);
        expect((yield* f.sql`SELECT id FROM pull_request_guide_jobs`).length).toBe(1);
        yield* restarted.wakeReviewGuides;
        yield* f.completed;
        expect(f.state.calls).toBe(1);
        expect(f.state.selections[0]).toMatchObject({
          pool: { objectName: "user-1:work", userId: "user-1" },
          modelSelection: selection,
        });
        expect(f.state.selections[0]!.instructions).toContain("Explain the accepted contract.");
        const finished = yield* (yield* f.make).reviewGuide(reference);
        expect(finished).toMatchObject({
          guide: { headSha: HEAD, modelSelection: selection },
          run: null,
          currentHeadSha: HEAD,
        });
        yield* restarted.generateReviewGuide(request);
        yield* restarted.wakeReviewGuides;
        expect(f.state.calls).toBe(1);
        expect(f.state.armed.length).toBeGreaterThan(0);
        expect(f.state.refreshes).toBeGreaterThan(0);
      }).pipe(Effect.provide(storage)),
  );

  it.effect(
    "rejects reused identities, stale heads and changed accounts without starting work",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.guides.generateReviewGuide(request);
        expect(
          yield* f.guides
            .generateReviewGuide({ ...request, headSha: "c".repeat(40) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "operation-conflict" });
        expect(
          yield* f.guides
            .generateReviewGuide({ ...request, operationId: "new", headSha: "c".repeat(40) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "conflict" });
        f.base.state.accountId = "new-account";
        expect(yield* f.guides.generateReviewGuide(request).pipe(Effect.flip)).toMatchObject({
          reason: "operation-conflict",
        });
        yield* f.guides.wakeReviewGuides;
        yield* f.completed;
        expect(f.state.calls).toBe(0);
        f.base.state.accountId = "123";
        expect((yield* f.guides.reviewGuide(reference)).run).toMatchObject({ _tag: "Failed" });
      }).pipe(Effect.provide(storage)),
  );

  it.effect("does not publish a result after access is lost while the model runs", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      f.state.beforeGeneration = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
      );
      yield* f.guides.generateReviewGuide(request);
      yield* f.guides.wakeReviewGuides;
      yield* Deferred.await(started);
      // The alarm has returned while the model is suspended; another alarm cannot duplicate it.
      yield* f.guides.wakeReviewGuides;
      expect(f.state.calls).toBe(1);
      f.base.state.accountId = "other-account";
      yield* Deferred.succeed(finish, undefined);
      yield* f.completed;
      f.base.state.accountId = "123";
      const result = yield* f.guides.reviewGuide(reference);
      expect(result.guide).toBeNull();
      expect(result.run?._tag).toBe("Failed");
    }).pipe(Effect.provide(storage)),
  );

  it.effect("keeps old guides bound to their head, and a new explicit request can regenerate", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.guides.generateReviewGuide(request);
      yield* f.guides.wakeReviewGuides;
      yield* f.completed;
      f.state.head = "c".repeat(40);
      expect(yield* f.guides.reviewGuide(reference)).toMatchObject({
        guide: { headSha: HEAD },
        currentHeadSha: f.state.head,
      });
      f.state.allowed = false;
      expect(yield* f.guides.reviewGuide(reference).pipe(Effect.flip)).toMatchObject({
        reason: "permission",
      });
      f.state.allowed = true;
      f.state.head = HEAD;
      yield* f.guides.generateReviewGuide({ ...request, operationId: "regenerate" });
      yield* f.guides.wakeReviewGuides;
      yield* f.completed;
      expect(f.state.calls).toBe(2);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("expires an interrupted completion without repeating the model request", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.guides.generateReviewGuide(request);
      const store = yield* makePullRequestGuideStore;
      yield* store.startNext(0);
      yield* f.guides.wakeReviewGuides;
      const result = yield* f.guides.reviewGuide(reference);
      expect(result).toMatchObject({ guide: null, run: { _tag: "Failed", headSha: HEAD } });
      yield* f.guides.generateReviewGuide(request);
      expect(f.state.calls).toBe(0);
      expect((yield* f.sql`SELECT id FROM pull_request_guide_jobs`).length).toBe(1);
    }).pipe(Effect.provide(storage)),
  );
});
