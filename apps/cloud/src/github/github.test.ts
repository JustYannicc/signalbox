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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { projectDriveId } from "../drive/DriveDirectory.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { threadRef, wipRef } from "../drive/DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import type { Bytes } from "../drive/git/gitObjects.ts";
import { remoteHead } from "../drive/remoteRoutes.ts";
import * as Platform from "../platform.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import * as CloudRpc from "../user/rpc.ts";
import * as GitHubConnection from "./GitHubConnection.ts";
import { makeFakeGitHub } from "./githubTesting.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const projectId = ProjectId.make("project-repo");
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

/** owner/repo on GitHub, and a machine's clone of it one commit deep, as a thread's Runner has it. */
const setup = () => {
  const upstream = makeRepo();
  cleanups.push(upstream.cleanup);
  upstream.write("README.md", "hello\n");
  upstream.commit("first");
  upstream.write("src/app.ts", "export {}\n");
  upstream.commit("second");
  upstream.git(["branch", "-m", "main"]);
  const bare = tempDir("github-bare-");
  git(bare, ["clone", "-q", "--bare", upstream.dir, "."]);
  const machine = tempDir("github-machine-");
  git(machine, ["clone", "-q", "--depth=1", `file://${bare}`, "."]);
  const pack = (include: ReadonlyArray<string>, exclude: ReadonlyArray<string> = []) => {
    const out = tempDir("github-pack-");
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

describe("GitHub-backed drives", () => {
  it.effect("connect, import, work on a thread's branch, push it and open a pull request", () => {
    const remote = setup();
    const github = makeFakeGitHub({
      bare: remote.bare,
      repository: "owner/repo",
      defaultBranch: "main",
    });
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const cloud = makeMemoryCloud({ github: github.layer, drives: drives.layer });
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });

      // Connecting: the grant works once, and only through the App's flow.
      const started = yield* user.beginGitHubConnect(REDIRECT);
      if (started._tag !== "started") return expect.unreachable();
      expect(started.url).toContain("client_id=Iv1.test");
      expect(started.url).toContain(`state=${started.grantId}`);
      const connected = { grantId: started.grantId, code: "code-1", redirectUri: REDIRECT };
      expect(yield* user.completeGitHubConnect(connected)).toEqual({
        _tag: "connected",
        login: "octo",
      });
      expect((yield* user.completeGitHubConnect(connected))._tag).toBe("failed");
      expect(yield* user.githubAccessToken()).toBe("ghu_0");

      const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, actor: { userId } }),
            CloudRpc.layerScopeAuthorization([
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
              AuthSourceControlWriteScope,
            ]),
          ).pipe(Layer.provide(cloud.layerFor(userId))),
        ),
      );

      const discovered = yield* rpc[WS_METHODS.serverDiscoverSourceControl]({});
      expect(discovered.sourceControlProviders[0]).toMatchObject({
        kind: "github",
        status: "available",
        auth: { status: "authenticated", account: Option.some("octo") },
      });
      const missing = yield* rpc[WS_METHODS.sourceControlLookupRepository]({
        provider: "github",
        repository: "owner/elsewhere",
      }).pipe(Effect.flip);
      expect(missing.message).toContain(
        "https://github.test/apps/signalbox-test/installations/new",
      );

      // Importing registers the repository at once; nothing is cloned.
      const imported = yield* rpc[WS_METHODS.projectCloneStart]({
        projectId,
        title: "repo",
        createdAt: "2026-10-08T10:00:00.000Z",
        remoteUrl: "https://github.com/owner/repo.git",
        destinationPath: "~/repo",
      });
      expect(imported).toMatchObject({ cwd: "/github/owner/repo" });
      const shell = yield* user.shellSnapshot();
      expect(shell.projects.find((project) => project.id === projectId)).toMatchObject({
        title: "repo",
        workspaceRoot: "/github/owner/repo",
      });
      const again = yield* rpc[WS_METHODS.projectCloneStart]({
        projectId: ProjectId.make("project-again"),
        title: "repo",
        createdAt: "2026-10-08T10:00:00.000Z",
        remoteUrl: "https://github.com/owner/repo",
        destinationPath: "~/repo",
      }).pipe(Effect.flip);
      expect(again.message).toContain("already a project");

      // A thread there gets its own branch, which clients address by its working tree.
      const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch-1"),
        threadId,
        projectId,
        title: "Make the app say hi",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      expect(launched.projection.thread).toMatchObject({
        branch: "signalbox/0000abcd",
        worktreePath: `/github/owner/repo/threads/${threadId}`,
      });
      const cwd = launched.projection.thread.worktreePath!;

      // What the thread's Runner does in its turn: mirror the remote's head, commit, auto-save.
      const driveId = projectDriveId(userId, projectId);
      const handle = (yield* DriveDirectory).forDrive(driveId);
      const writer = { threadId, generation: 1, live: true, packsAfter: 0 };
      yield* uploadPack({
        driveId,
        threadId,
        ...remote.pack([remote.head]),
        remoteHead: remote.head,
      });
      yield* handle.mirror(writer, { expectedMain: null, newMain: remote.head });
      yield* handle.open(writer);
      NodeFS.writeFileSync(NodePath.join(remote.machine, "src/app.ts"), "export const hi = 1;\n");
      git(remote.machine, ["commit", "-qam", "Say hi"]);
      const turn = git(remote.machine, ["rev-parse", "HEAD"]);
      NodeFS.writeFileSync(NodePath.join(remote.machine, "draft.md"), "unsaved idea\n");
      git(remote.machine, ["add", "-A"]);
      const autosave = git(remote.machine, [
        "commit-tree",
        git(remote.machine, ["write-tree"]),
        "-p",
        turn,
        "-m",
        "Auto-save",
      ]);
      yield* uploadPack({ driveId, threadId, ...remote.pack([autosave], [remote.head]) });
      yield* handle.updateRefs(writer, [
        { name: threadRef(threadId), old: remote.head, new: turn },
        { name: wipRef(threadId), old: null, new: autosave },
      ]);

      const status = () =>
        rpc[WS_METHODS.subscribeVcsStatus]({ cwd }).pipe(Stream.take(1), Stream.runHead);
      expect(yield* status()).toMatchObject(
        Option.some({
          _tag: "snapshot",
          local: { isRepo: true, refName: "signalbox/0000abcd", hasPrimaryRemote: true },
          remote: { hasUpstream: false, aheadCount: 1, aheadOfDefaultCount: 1, pr: null },
        }),
      );

      const events = yield* rpc[WS_METHODS.gitRunStackedAction]({
        actionId: "action-1",
        cwd,
        action: "create_pr",
        threadId,
      }).pipe(Stream.runCollect);
      expect(events.map((event) => event.kind)).toEqual([
        "action_started",
        "phase_started",
        "phase_started",
        "action_finished",
      ]);
      const finished = events.at(-1);
      expect(finished).toMatchObject({
        kind: "action_finished",
        result: {
          push: { status: "pushed", branch: "signalbox/0000abcd" },
          pr: {
            status: "created",
            number: 1,
            url: "https://github.test/owner/repo/pull/1",
            baseBranch: "main",
            headBranch: "signalbox/0000abcd",
            title: "Make the app say hi",
          },
        },
      });
      // Only the turn's commit reached GitHub; the auto-save never did.
      expect(github.head("signalbox/0000abcd")).toBe(turn);
      expect(() => git(remote.bare, ["cat-file", "-e", autosave])).toThrow();
      expect(github.calls.filter((call) => call.includes("git-receive-pack"))).toHaveLength(1);

      expect(yield* status()).toMatchObject(
        Option.some({
          remote: { hasUpstream: true, aheadCount: 0, pr: { number: 1, state: "open" } },
        }),
      );

      // Merged on GitHub: it's the remote's head that main may now mirror.
      github.merge(1);
      const head = yield* remoteHead(driveId, userId).pipe(
        Effect.provideService(UserDirectory, cloud.userDirectory),
      );
      expect(head).toBe(turn);
      expect(yield* status()).toMatchObject(Option.some({ remote: { pr: { state: "merged" } } }));
    }).pipe(Effect.provide(Layer.mergeAll(drives.layer, github.layer)));
  });

  it.effect(
    "refreshes a token about to expire, and forgets a connection GitHub turned down",
    () => {
      const remote = setup();
      const github = makeFakeGitHub({
        bare: remote.bare,
        repository: "owner/repo",
        defaultBranch: "main",
      });
      return Effect.gen(function* () {
        const connection = yield* GitHubConnection.GitHubConnection;
        const started = yield* connection.begin(REDIRECT);
        if (started._tag !== "started") return expect.unreachable();
        yield* connection.complete({ grantId: started.grantId, code: "c", redirectUri: REDIRECT });
        expect(yield* connection.accessToken).toBe("ghu_0");

        // GitHub's user tokens last eight hours; this one is close enough to renew.
        yield* TestClock.adjust("478 minutes");
        expect(yield* connection.accessToken).toBe("ghu_1");
        expect(yield* connection.accessToken).toBe("ghu_1");

        // An outage is not a refusal: the connection stays for the next try.
        github.settings.refreshOutage = true;
        yield* TestClock.adjust("8 hours");
        expect((yield* connection.accessToken.pipe(Effect.flip))._tag).toBe("GitHubError");
        expect(yield* connection.account).toEqual({ login: "octo" });

        github.settings.refreshOutage = false;
        github.settings.refuseRefresh = true;
        expect(yield* connection.accessToken).toBeNull();
        expect(yield* connection.account).toBeNull();
        // Gone for good: the next request doesn't even ask GitHub.
        const asked = github.calls.length;
        expect(yield* connection.accessToken).toBeNull();
        expect(github.calls.length).toBe(asked);
      }).pipe(
        Effect.provide(
          GitHubConnection.layer.pipe(
            Layer.provideMerge(github.layer),
            Layer.provideMerge(Layer.effectDiscard(GitHubConnection.createTables)),
            Layer.provideMerge(
              Layer.mergeAll(
                NodeSqliteClient.layer({ filename: ":memory:" }),
                Platform.layerCrypto,
              ),
            ),
          ),
        ),
      );
    },
  );
});
