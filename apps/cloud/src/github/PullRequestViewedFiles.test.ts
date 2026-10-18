import {
  PullRequestOperationError,
  ProjectId,
  type PullRequestDiffResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as UserDrives from "../user/UserDrives.ts";
import * as PullRequestRepository from "./PullRequestRepository.ts";
import { makePullRequestViewedFiles } from "./PullRequestViewedFiles.ts";

const projectId = ProjectId.make("project_1");
const reference = (overrides: Partial<PullRequestRef> = {}): PullRequestRef => ({
  projectId,
  repository: "acme/web",
  number: 7,
  ...overrides,
});

const revision = (base: string, head: string) => ({
  baseSha: base.repeat(40),
  headSha: head.repeat(40),
});

const filePatch = (path: string, value: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${value}\n`;

const fixture = () => {
  const state = {
    accountId: "101",
    viewer: "alice",
    host: "github.com",
    denied: false,
    role: "viewer" as string | null,
    invalidations: 0,
    resolves: 0,
    diffCalls: 0,
    fileRevisionCalls: 0,
    fileRevisions: new Map([
      ["src/a.ts", "blob-a-v1"],
      ["src/b.ts", "blob-b-v1"],
    ]),
    pages: [
      {
        revision: revision("a", "b"),
        patch: filePatch("src/a.ts", "one") + filePatch("src/b.ts", "two"),
      },
    ],
    blockNext: null as null | {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    },
  };

  const repository = PullRequestRepository.PullRequestRepository.of({
    resolve: (input: PullRequestRef) =>
      Effect.gen(function* () {
        state.resolves += 1;
        if (state.denied || state.role === null)
          return yield* new PullRequestOperationError({
            operation: "routeIdentity",
            detail: "The project is no longer available.",
            reason: "permission",
          });
        return {
          project: {} as never,
          repository: input.repository,
          host: input.host ?? state.host,
          token: "token",
          viewer: state.viewer,
          accountId: state.accountId,
        };
      }),
  } as unknown as PullRequestRepository.PullRequestRepository["Service"]);

  const drives = UserDrives.UserDrives.of({
    userId: Effect.succeed("user_1"),
    access: () => Effect.succeed(state.role as "viewer" | null),
  } as unknown as UserDrives.UserDrives["Service"]);

  const dependencies = Layer.mergeAll(
    Layer.succeed(PullRequestRepository.PullRequestRepository, repository),
    Layer.succeed(UserDrives.UserDrives, drives),
    NodeSqliteClient.layer({ filename: ":memory:" }),
  );

  const make = () =>
    makePullRequestViewedFiles({
      invalidate: () => Effect.sync(() => void (state.invalidations += 1)),
      diff: (input) =>
        Effect.gen(function* () {
          state.diffCalls += 1;
          const blocked = state.blockNext;
          if (blocked !== null) {
            state.blockNext = null;
            yield* Deferred.succeed(blocked.started, undefined);
            yield* Deferred.await(blocked.release);
          }
          const index = input.cursor === undefined ? 0 : Number(input.cursor);
          const page = state.pages[index];
          if (page === undefined)
            return yield* new PullRequestOperationError({
              operation: "diff",
              detail: "The current diff page is missing.",
            });
          return {
            revision: page.revision,
            patch: page.patch,
            truncated: false,
            nextCursor: index + 1 < state.pages.length ? String(index + 1) : null,
          } satisfies PullRequestDiffResult;
        }),
      fileRevisions: (_target, _revision, files) =>
        Effect.sync(() => {
          state.fileRevisionCalls += 1;
          return new Map<string, string>(
            files.map((file): [string, string] => [
              file.path,
              state.fileRevisions.get(file.path) ?? "missing",
            ]),
          );
        }),
    });

  return { state, make, dependencies };
};

const mark = (displayedRevision = revision("a", "b")) => ({
  ...reference(),
  displayedRevision,
  files: [{ path: "src/a.ts", viewed: true }],
});

it.effect("persists per-file marks and isolates them by GitHub account and repository", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const viewed = yield* f.make();
    yield* viewed.setFilesViewed(mark());
    expect(yield* viewed.filesViewed(reference())).toMatchObject({
      files: [{ path: "src/a.ts", state: "viewed" }],
    });
    expect(f.state.invalidations).toBe(1);

    f.state.accountId = "202";
    expect(yield* viewed.filesViewed(reference())).toMatchObject({ files: [] });
    f.state.accountId = "101";
    f.state.viewer = "bob";
    expect(yield* viewed.filesViewed(reference())).toMatchObject({ files: [] });
    f.state.viewer = "alice";
    expect(yield* viewed.filesViewed(reference({ repository: "acme/other" }))).toMatchObject({
      files: [],
    });
    expect(yield* viewed.filesViewed(reference({ number: 8 }))).toMatchObject({ files: [] });

    f.state.host = "github.example";
    expect(yield* viewed.filesViewed(reference({ host: "github.example" }))).toMatchObject({
      files: [],
    });
    expect(f.state.resolves).toBeGreaterThanOrEqual(7);
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("rereads the durable mark through a newly created factory", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const first = yield* f.make();
    yield* first.setFilesViewed(mark());
    const reopened = yield* f.make();
    expect(yield* reopened.filesViewed(reference())).toMatchObject({
      files: [{ path: "src/a.ts", state: "viewed" }],
    });
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("clears a personal mark after the file leaves the diff", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const viewed = yield* f.make();
    yield* viewed.setFilesViewed(mark());
    f.state.pages[0] = { revision: revision("a", "c"), patch: filePatch("src/b.ts", "new") };
    yield* viewed.setFilesViewed({
      ...reference(),
      displayedRevision: revision("a", "b"),
      files: [{ path: "src/a.ts", viewed: false }],
    });
    expect(yield* viewed.filesViewed(reference())).toMatchObject({ files: [] });
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("rejects stale revisions and paths outside the current diff", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const viewed = yield* f.make();
    f.state.pages[0] = {
      revision: revision("a", "c"),
      patch: filePatch("src/a.ts", "new"),
    };
    const stale = yield* Effect.flip(viewed.setFilesViewed(mark(revision("a", "b"))));
    expect(stale).toMatchObject({ reason: "conflict" });

    const forged = yield* Effect.flip(
      viewed.setFilesViewed({
        ...reference(),
        displayedRevision: revision("a", "c"),
        files: [{ path: "secret.txt", viewed: true }],
      }),
    );
    expect(forged).toMatchObject({ reason: "invalid" });
    expect(yield* viewed.filesViewed(reference())).toMatchObject({ files: [] });
    expect(f.state.invalidations).toBe(0);
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("dismisses only the file whose exact patch changed", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const viewed = yield* f.make();
    yield* viewed.setFilesViewed({
      ...reference(),
      displayedRevision: revision("a", "b"),
      files: [
        { path: "src/a.ts", viewed: true },
        { path: "src/b.ts", viewed: true },
      ],
    });
    f.state.pages[0] = {
      revision: revision("a", "c"),
      patch: filePatch("src/a.ts", "changed") + filePatch("src/b.ts", "two"),
    };
    f.state.fileRevisions.set("src/a.ts", "blob-a-v2");
    expect(yield* viewed.filesViewed(reference())).toMatchObject({
      files: [
        { path: "src/a.ts", state: "dismissed" },
        { path: "src/b.ts", state: "viewed" },
      ],
    });
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("serializes a later untick behind an in-flight tick", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const viewed = yield* f.make();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.state.blockNext = { started, release };
    const tick = yield* Effect.forkChild(viewed.setFilesViewed(mark()));
    yield* Deferred.await(started);
    const untick = yield* Effect.forkChild(
      viewed.setFilesViewed({ ...reference(), files: [{ path: "src/a.ts", viewed: false }] }),
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(tick);
    yield* Fiber.join(untick);
    expect(yield* viewed.filesViewed(reference())).toMatchObject({ files: [] });
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("rechecks current folder and connection authority for writes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const viewed = yield* f.make();
    yield* viewed.setFilesViewed(mark());
    f.state.denied = true;
    const denied = yield* Effect.flip(viewed.setFilesViewed(mark()));
    expect(denied).toMatchObject({ reason: "permission" });
    f.state.denied = false;
    f.state.role = null;
    const removed = yield* Effect.flip(viewed.filesViewed(reference()));
    expect(removed).toMatchObject({ reason: "permission" });
  }).pipe(Effect.provide(f.dependencies));
});
