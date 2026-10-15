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
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
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
import { makeFakeGitHub } from "../github/githubTesting.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

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

describe("cloud automations watch a cloud thread's pull request", () => {
  it.effect("wakes the thread when CI finishes on the pull request it opened (#397)", () => {
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
      expect(branchJson.publish.decode(yield* Effect.promise(() => response.text()))).toMatchObject(
        { _tag: "published", pullRequest: { number: 1, created: true } },
      );
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

      // The first read: open, checks running.
      github.update(1, {
        checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null }],
      });
      yield* cloud.syncPullRequests(threadId);
      yield* cloud.settle;

      // The agent asks Signalbox to watch it, from its machine.
      const watched = yield* cloud.inUser(
        userId,
        CloudAutomations.use((automations) =>
          automations.tool({ threadId }, "watch_pull_request", { number: 1 }),
        ),
      );
      expect(watched).toMatchObject({ number: 1, repository: "owner/repo", watching: true });
      yield* cloud.settle;

      // CI passes; the next sync's event reaches the watch, which wakes the agent.
      github.update(1, {
        checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
      yield* cloud.forgetPullRequestPolls(threadId);
      yield* cloud.syncPullRequests(threadId);
      yield* cloud.settle;
      const messages = (yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }))
        .messages;
      expect(
        messages.some((message) =>
          message.text.startsWith(
            "Checks passed on pull request #1 (https://github.test/owner/repo/pull/1).",
          ),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(Layer.mergeAll(cloud.drives.layer, github.layer)),
      Effect.provideService(UserDirectory, cloud.userDirectory),
    );
  });
});
