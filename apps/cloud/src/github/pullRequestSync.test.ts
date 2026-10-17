// @effect-diagnostics nodeBuiltinImport:off - GitHub's side is a real bare repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { branchJson } from "@signalbox/runner-protocol/BranchProtocol";

import { serveBranchRequest } from "../drive/branchRoutes.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { threadRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import type { Bytes } from "../drive/git/gitObjects.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import * as CloudRpc from "../user/rpc.ts";
import { makeFakeGitHub } from "./githubTesting.ts";
import * as PullRequestMerges from "./PullRequestMerges.ts";
import * as PullRequestReads from "./PullRequestReads.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const threadId = ThreadId.make("thread-0000abcd");
const REDIRECT = "http://localhost:8787/api/github/callback";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const tempDir = (prefix: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Signalbox",
  GIT_AUTHOR_EMAIL: "agent@signalbox.invalid",
  GIT_COMMITTER_NAME: "Signalbox",
  GIT_COMMITTER_EMAIL: "agent@signalbox.invalid",
};
const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, input, encoding: "utf8" }).trim();

/** owner/repo on GitHub, and a machine's clone of it, as in `github.test.ts`. */
const setup = () => {
  const upstream = makeRepo();
  cleanups.push(upstream.cleanup);
  upstream.write("README.md", "hello\n");
  upstream.commit("first");
  upstream.git(["branch", "-m", "main"]);
  const bare = tempDir("pr-sync-bare-");
  git(bare, ["clone", "-q", "--bare", upstream.dir, "."]);
  const machine = tempDir("pr-sync-machine-");
  git(machine, ["clone", "-q", "--depth=1", `file://${bare}`, "."]);
  const pack = (include: ReadonlyArray<string>, exclude: ReadonlyArray<string> = []) => {
    const out = tempDir("pr-sync-pack-");
    const name = git(
      machine,
      ["pack-objects", "--revs", "--delta-base-offset", NodePath.join(out, "pack")],
      [...include, ...exclude.map((oid) => `^${oid}`)].join("\n") + "\n",
    );
    const read = (ext: string): Bytes =>
      new Uint8Array(NodeFS.readFileSync(NodePath.join(out, `pack-${name}.${ext}`)));
    return { pack: read("pack"), idx: read("idx") };
  };
  return { bare, machine, pack, head: git(machine, ["rev-parse", "HEAD"]) };
};

const syncedEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events.flatMap((event) => (event.type === "thread.pull-request-synced" ? [event] : []));

describe("cloud pull request sync", () => {
  it.effect(
    "links the pull request the agent opened, syncs it until it merges, and reads its details",
    () => {
      const remote = setup();
      const github = makeFakeGitHub({
        bare: remote.bare,
        repository: "owner/repo",
        defaultBranch: "main",
      });
      const cloud = makeMemoryCloud({ github: github.layer });
      return Effect.gen(function* () {
        const user = cloud.userDirectory.forUser(userId);
        yield* user.recordSignIn({ id: userId, email: "a@b.c" });
        yield* user.beginGitHubConnect({ grantId: "g1", returnTo: REDIRECT });
        github.authorize(userId);
        yield* user.completeGitHubConnect("g1");
        const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
              CloudRpc.layerScopeAuthorization([
                AuthOrchestrationReadScope,
                AuthOrchestrationOperateScope,
                AuthSourceControlWriteScope,
              ]),
            ).pipe(Layer.provide(cloud.layerFor(userId))),
          ),
        );
        const imported = yield* rpc[WS_METHODS.projectCloneStart]({
          projectId: ProjectId.make("project-from-the-client"),
          title: "repo",
          createdAt: "2026-10-08T10:00:00.000Z",
          remoteUrl: "https://github.com/owner/repo.git",
          destinationPath: "~/repo",
        });
        const driveId = imported.cwd.slice("/drives/".length);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make(`launch-${threadId}`),
          threadId,
          projectId: imported.projectId,
          title: "Make the app say hi",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });

        // The thread's Runner saved a commit on its branch.
        const handle = (yield* DriveDirectory).forDrive(driveId);
        const writer = { threadId, userId, generation: 1, live: true, packsAfter: 0 };
        yield* uploadPack({
          driveId,
          threadId,
          ...remote.pack([remote.head]),
          remoteHead: remote.head,
        });
        yield* handle.mirror(writer, { expectedMain: null, newMain: remote.head });
        yield* handle.open(writer);
        NodeFS.writeFileSync(NodePath.join(remote.machine, "app.ts"), "export const hi = 1;\n");
        git(remote.machine, ["add", "app.ts"]);
        git(remote.machine, ["commit", "-qm", "Say hi"]);
        const turn = git(remote.machine, ["rev-parse", "HEAD"]);
        yield* uploadPack({ driveId, threadId, ...remote.pack([turn], [remote.head]) });
        yield* handle.updateRefs(writer, [
          { name: threadRef(threadId), old: remote.head, new: turn },
        ]);

        // Nothing linked, nothing to read.
        expect(yield* cloud.syncPullRequests(threadId)).toBeNull();

        // The agent opens its pull request.
        const response = yield* serveBranchRequest(
          { userId, threadId, driveId, live: true },
          JSON.stringify({ action: "create_pr", title: "Say hi" }),
        );
        expect(
          branchJson.publish.decode(yield* Effect.promise(() => response.text())),
        ).toMatchObject({ _tag: "published", pullRequest: { number: 1, created: true } });
        const linked = (yield* cloud.threadEvents(threadId)).at(-1);
        if (linked?.type !== "thread.pull-request-synced") return expect.unreachable();
        expect(linked.payload.pullRequests).toEqual([
          expect.objectContaining({
            host: "github.test",
            repository: "owner/repo",
            number: 1,
            url: "https://github.test/owner/repo/pull/1",
            source: "created",
            snapshot: null,
          }),
        ]);

        // The alarm reads it: open, checks running.
        github.update(1, {
          checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null }],
        });
        const first = yield* cloud.syncPullRequests(threadId);
        expect(first).not.toBeNull();
        const afterFirst = syncedEvents(yield* cloud.threadEvents(threadId));
        expect(afterFirst.at(-1)?.payload.pullRequests?.[0]?.snapshot).toMatchObject({
          state: "open",
          title: "Say hi",
          headBranch: "signalbox/0000abcd",
          baseBranch: "main",
          isDraft: false,
          checksState: "pending",
          mergeability: "mergeable",
          author: { login: "octo" },
        });

        // Read again before it is due: nothing is asked of GitHub.
        const calls = github.calls.length;
        expect(yield* cloud.syncPullRequests(threadId)).toBe(first);
        expect(github.calls.length).toBe(calls);

        // Due again, unchanged on GitHub: no event.
        yield* cloud.forgetPullRequestPolls(threadId);
        yield* cloud.syncPullRequests(threadId);
        expect(syncedEvents(yield* cloud.threadEvents(threadId))).toHaveLength(afterFirst.length);

        // CI fails, and the sync says so; the reads name the failed check.
        github.update(1, {
          checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
        });
        yield* cloud.forgetPullRequestPolls(threadId);
        yield* cloud.syncPullRequests(threadId);
        const failed = syncedEvents(yield* cloud.threadEvents(threadId)).at(-1);
        expect(failed?.payload.pullRequests?.[0]?.snapshot?.checksState).toBe("failing");

        const reads = yield* PullRequestReads.PullRequestReads.pipe(
          Effect.provide(PullRequestReads.layer.pipe(Layer.provide(cloud.userObject(userId)))),
        );
        const ref = {
          projectId: imported.projectId,
          host: "github.test",
          repository: "owner/repo",
          number: 1,
        };
        github.update(1, {
          labels: ["ready-for-review"],
          reviews: [
            {
              id: "review-1",
              author: "reviewer",
              body: "Please fix the test.",
              state: "CHANGES_REQUESTED",
              at: "2026-10-08T00:20:00Z",
            },
          ],
        });
        const merges = yield* PullRequestMerges.PullRequestMerges.pipe(
          Effect.provide(PullRequestMerges.layer.pipe(Layer.provide(cloud.userObject(userId)))),
        );
        expect(yield* merges.evidence(ref)).toMatchObject({
          baseSha: remote.head,
          baseRepository: "owner/repo",
          labels: ["ready-for-review"],
          reviews: [
            {
              author: "reviewer",
              state: "changes-requested",
              submittedAt: "2026-10-08T00:20:00Z",
              body: "Please fix the test.",
            },
          ],
        });
        expect(yield* reads.failedChecks(ref)).toEqual([
          { name: "test", status: "failure", url: "https://github.test/owner/repo/runs/test" },
        ]);
        github.update(1, {
          remarks: [
            {
              id: "c1",
              kind: "issue",
              author: "reviewer",
              body: "Old news",
              at: "2026-10-08T00:00:00Z",
            },
            {
              id: "c2",
              kind: "issue",
              author: "reviewer",
              body: "Please <!-- hidden --> fix   the test",
              at: "2026-10-08T00:10:00Z",
            },
            { id: "c3", kind: "issue", author: "octo", body: "On it", at: "2026-10-08T00:11:00Z" },
            {
              id: "l1",
              kind: "line",
              author: "reviewer",
              body: "Typo",
              path: "app.ts",
              at: "2026-10-08T00:12:00Z",
            },
            {
              id: "r1",
              kind: "review",
              author: "reviewer",
              body: "",
              state: "CHANGES_REQUESTED",
              at: "2026-10-08T00:13:00Z",
            },
            // Only holds line comments, which are listed themselves.
            {
              id: "r2",
              kind: "review",
              author: "reviewer",
              body: "",
              state: "COMMENTED",
              at: "2026-10-08T00:14:00Z",
            },
          ],
        });
        expect(yield* reads.remarksSince(ref, "2026-10-08T00:05:00Z")).toEqual([
          {
            id: "c2",
            kind: "issue-comment",
            author: "reviewer",
            body: "Please fix the test",
            path: null,
            reviewState: null,
            url: "https://github.test/owner/repo/pull/1#c2",
            at: "2026-10-08T00:10:00Z",
          },
          expect.objectContaining({ id: "l1", kind: "review-comment", path: "app.ts" }),
          expect.objectContaining({ id: "r1", kind: "review", reviewState: "CHANGES_REQUESTED" }),
        ]);
        // Another host's pull request isn't this GitHub's to read.
        expect(yield* reads.failedChecks({ ...ref, host: "gitlab.com" })).toBeNull();

        // GitHub's rate limit: the sync waits for the time it gave.
        github.settings.rateLimited = true;
        yield* cloud.forgetPullRequestPolls(threadId);
        const paused = yield* cloud.syncPullRequests(threadId);
        // Two minutes on, where the first read's next was one.
        expect(paused! - first!).toBeGreaterThanOrEqual(60_000);
        github.settings.rateLimited = false;

        // Merged: synced once more, then never read again.
        github.merge(1);
        yield* cloud.forgetPullRequestPolls(threadId);
        expect(yield* cloud.syncPullRequests(threadId)).toBeNull();
        const merged = syncedEvents(yield* cloud.threadEvents(threadId)).at(-1);
        expect(merged?.payload.pullRequests?.[0]?.snapshot?.state).toBe("merged");
        const settled = github.calls.length;
        yield* cloud.forgetPullRequestPolls(threadId);
        expect(yield* cloud.syncPullRequests(threadId)).toBeNull();
        expect(github.calls.length).toBe(settled);

        // The sidebar row carries the link, as clients read it.
        const summary = yield* Effect.promise(() =>
          cloud.threadDirectory
            .forThread(threadId)
            .snapshot({ userId, contextIds: [PERSONAL_CONTEXT_ID] })
            .pipe(Effect.runPromise),
        );
        expect(summary.projection.thread.pullRequests?.[0]?.snapshot?.state).toBe("merged");
      }).pipe(
        Effect.provide(Layer.mergeAll(cloud.drives.layer, github.layer)),
        Effect.provideService(UserDirectory, cloud.userDirectory),
      );
    },
  );
});
