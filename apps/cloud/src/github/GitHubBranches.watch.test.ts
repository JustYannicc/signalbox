import { describe, expect, it } from "@effect/vitest";
import type { VcsStatusStreamEvent } from "@t3tools/contracts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { DriveDirectory, type DriveHandle } from "../drive/DriveDirectory.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { layerCrypto } from "../platform.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { ThreadNotFoundError } from "../thread/ThreadAccess.ts";
import { projectIdForDrive } from "../user/contextProjects.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import { makeGitHubApi } from "./GitHubApi.ts";
import * as GitHubBranches from "./GitHubBranches.ts";
import { GitHubConnection } from "./GitHubConnection.ts";
import { actor, current, driveId, snapshot, threadId } from "./githubRefsTesting.ts";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const REMOTE = {
  provider: "github",
  repository: "owner/repository",
  defaultBranch: "main",
} as const;

class TestDrive extends Context.Service<TestDrive, DriveHandle>()("test/GitHubBranches/Drive") {}

const commit = (oid: string, parents: ReadonlyArray<string>) => ({
  oid,
  tree: "f".repeat(40),
  parents,
  authorName: "Signalbox",
  authorEmail: "agent@signalbox.invalid",
  time: 0,
  message: oid,
});

/** A thread one commit past main, watched with every check counted and each one revocable. */
const fixture = Effect.gen(function* () {
  const state = {
    role: "manager" as SignalboxDriveRole | null,
    threadVisible: true,
    repositoryStatus: 200,
    baseExists: true,
    driveChecks: 0,
    threadChecks: 0,
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const respond = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (path === `/repos/${REMOTE.repository}`) {
        return state.repositoryStatus === 200
          ? respond({
              id: 1,
              full_name: REMOTE.repository,
              name: "repository",
              default_branch: "main",
              html_url: "https://github.com/owner/repository",
              clone_url: "https://github.com/owner/repository.git",
              ssh_url: "git@github.com:owner/repository.git",
            })
          : respond({ message: "Not Found" }, state.repositoryStatus);
      }
      if (path === `/repos/${REMOTE.repository}/git/ref/heads/main` && state.baseExists) {
        return respond({ object: { sha: BASE } });
      }
      if (path === `/repos/${REMOTE.repository}/pulls`) return respond([]);
      return respond({ message: "Not Found" }, 404);
    }),
  );
  const drive = yield* TestDrive.pipe(
    Effect.provide(
      Layer.mock(TestDrive, {
        remote: () => Effect.succeed(REMOTE),
        refs: () =>
          Effect.succeed({
            main: BASE,
            thread: HEAD,
            wip: HEAD,
            machine: null,
            base: BASE,
            packs: [],
            remote: REMOTE,
            shallow: [BASE],
          }),
        commits: (oids) =>
          Effect.succeed(
            [commit(HEAD, [BASE]), commit(BASE, [])].filter((found) => oids.includes(found.oid)),
          ),
      }),
    ),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(GitHub, { pipesForUser: () => Effect.succeed(null), api: makeGitHubApi(client) }),
    Layer.mock(GitHubConnection, {
      configured: Effect.succeed(true),
      accessToken: Effect.succeed("github-token"),
    }),
    Layer.mock(UserDrives, {
      access: () =>
        Effect.sync(() => {
          state.driveChecks++;
          return state.role;
        }),
    }),
    Layer.mock(CloudThreadService, {
      threadSnapshot: (by, id) =>
        Effect.suspend(() => {
          state.threadChecks++;
          return state.threadVisible && by.userId === actor.userId && id === threadId
            ? Effect.succeed({
                ...snapshot,
                projection: {
                  ...snapshot.projection,
                  thread: { ...snapshot.projection.thread, projectId: projectIdForDrive(driveId) },
                },
              })
            : Effect.fail(new ThreadNotFoundError({}));
        }),
    }),
    Layer.succeed(DriveDirectory, { forDrive: () => drive }),
    Layer.mock(DrivePacks, {}),
    Layer.mock(DriveFiles, {
      compare: () =>
        Effect.succeed([{ path: "src/app.ts", additions: 99, deletions: 0, patch: "" }]),
    }),
    layerCrypto,
  );
  const branches = yield* GitHubBranches.GitHubBranches.pipe(
    Effect.provide(GitHubBranches.layer.pipe(Layer.provide(layer))),
  );
  /** Watches the thread's status, its events landing in a queue and its end in `fiber`. */
  const watch = Effect.gen(function* () {
    const events = yield* Queue.unbounded<VcsStatusStreamEvent>();
    const fiber = yield* branches.watch(actor, current.path, true).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkChild,
    );
    return { events, fiber };
  });
  return { state, watch };
});

const localOf = (event: VcsStatusStreamEvent) =>
  event._tag === "remoteUpdated" ? null : event.local;

describe("a watched branch status", () => {
  it.effect("counts the branch's committed changes, checking access on every refresh", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* fixture;
      const { events } = yield* watch;
      expect(localOf(yield* Queue.take(events))).toMatchObject({
        branchChanges: { baseRef: "main", insertions: 99, deletions: 0 },
      });
      const checks = { drive: state.driveChecks, thread: state.threadChecks };
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");
      expect(state.driveChecks).toBe(checks.drive + 2);
      expect(state.threadChecks).toBe(checks.thread + 2);
    }),
  );

  it.effect("ends once the drive is taken away", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* fixture;
      const { events, fiber } = yield* watch;
      yield* Queue.take(events);
      state.role = null;
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("You can't open this drive.");
      expect(yield* Queue.size(events)).toBe(0);
    }),
  );

  it.effect("ends once the thread is no longer visible", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* fixture;
      const { events, fiber } = yield* watch;
      yield* Queue.take(events);
      state.threadVisible = false;
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("This thread is unavailable.");
      expect(yield* Queue.size(events)).toBe(0);
    }),
  );

  it.effect("says why changes can't be counted instead of reporting zero", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* fixture;
      const { events } = yield* watch;
      yield* Queue.take(events);
      // Totals are cached, but losing the repository on GitHub still withholds them.
      state.repositoryStatus = 404;
      yield* TestClock.adjust("30 seconds");
      const revoked = localOf(yield* Queue.take(events));
      expect(revoked?.branchChanges).toBeUndefined();
      expect(revoked?.branchChangesError).toBe("You can't open this repository on GitHub.");

      state.repositoryStatus = 200;
      state.baseExists = false;
      yield* TestClock.adjust("30 seconds");
      const noBase = localOf(yield* Queue.take(events));
      expect(noBase?.branchChanges).toBeUndefined();
      expect(noBase?.branchChangesError).toBe("main isn't a branch on GitHub.");
    }),
  );
});
