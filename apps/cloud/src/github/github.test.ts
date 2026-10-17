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
  SourceControlProviderKind,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { SIGNALBOX_REPOSITORIES_WS_METHODS } from "@t3tools/contracts/signalboxRepositories";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { branchJson, type PublishResult } from "@signalbox/runner-protocol/BranchProtocol";

import { serveBranchRequest } from "../drive/branchRoutes.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { threadRef, wipRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import type { Bytes } from "../drive/git/gitObjects.ts";
import { makeDriveReader } from "../drive/DriveReader.ts";
import { makeRemoteFiles } from "../drive/remoteFiles.ts";
import * as Environment from "../environment.ts";
import { remoteHead } from "../drive/remoteRoutes.ts";
import * as Platform from "../platform.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as IdentityProvider from "../account/IdentityProvider.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import * as UserStore from "../user/UserStore.ts";
import * as CloudRpc from "../user/rpc.ts";
import { GitHub, layerForUsers } from "./GitHub.ts";
import * as GitHubConnection from "./GitHubConnection.ts";
import { makeFakeGitHub } from "./githubTesting.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const projectId = ProjectId.make("project-from-the-client");
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
  const pack = (
    include: ReadonlyArray<string>,
    exclude: ReadonlyArray<string> = [],
    filter?: string,
  ) => {
    const out = tempDir("github-pack-");
    const name = git(
      machine,
      [
        "pack-objects",
        "--revs",
        ...(filter === undefined ? [] : [`--filter=${filter}`]),
        "--delta-base-offset",
        NodePath.join(out, "pack"),
      ],
      [...include, ...exclude.map((oid) => `^${oid}`)].join("\n") + "\n",
    );
    const read = (ext: string): Bytes =>
      new Uint8Array(NodeFS.readFileSync(NodePath.join(out, `pack-${name}.${ext}`)));
    return { pack: read("pack"), idx: read("idx") };
  };
  return { bare, machine, pack, head: git(machine, ["rev-parse", "HEAD"]) };
};

describe("commitAuthorOf", () => {
  it("names commits by the login when the account has no usable display name", () => {
    const account = { login: "octo", githubUserId: 1 };
    expect(GitHubConnection.commitAuthorOf({ ...account, name: null })).toEqual({
      name: "octo",
      email: "1+octo@users.noreply.github.com",
    });
    expect(GitHubConnection.commitAuthorOf({ ...account, name: " <>\n " }).name).toBe("octo");
    // git would drop the dot and then refuse an empty name.
    expect(GitHubConnection.commitAuthorOf({ ...account, name: "." }).name).toBe("octo");
    expect(GitHubConnection.commitAuthorOf({ ...account, name: "Octo <Cat>" }).name).toBe(
      "Octo Cat",
    );
  });
});

it.effect("reports GitHub availability from each user's resolved WorkOS realm", () => {
  const sandboxUserId = "sandbox-user";
  const identityProviders = IdentityProvider.IdentityProviders.of({
    identityProviderForUser: (id) =>
      Effect.succeed(
        id === sandboxUserId
          ? {
              clientId: "client_sandbox",
              apiKey: Redacted.make("sk_test_sandbox"),
              apiBaseUrl: "https://sandbox.workos.test",
            }
          : {
              clientId: "client_primary",
              apiBaseUrl: "https://primary.workos.test",
            },
      ),
  });
  const github = layerForUsers().pipe(
    Layer.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(IdentityProvider.IdentityProviders, identityProviders),
      ),
    ),
  );
  const cloud = makeMemoryCloud({ github });

  const discover = (id: string) =>
    Effect.gen(function* () {
      yield* cloud.userDirectory.forUser(id).recordSignIn({
        id,
        email: `${id}@example.test`,
      });
      const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId: id, sid: `session-${id}` }),
            CloudRpc.layerScopeAuthorization([AuthOrchestrationReadScope]),
          ).pipe(Layer.provide(cloud.layerFor(id))),
        ),
      );
      return yield* rpc[WS_METHODS.serverDiscoverSourceControl]({});
    });

  return Effect.gen(function* () {
    const ordinary = yield* discover("ordinary-user");
    expect(ordinary.sourceControlProviders[0]).toMatchObject({
      kind: "github",
      status: "missing",
      installHint: "This cloud can't connect GitHub: it has no WorkOS API key.",
    });

    const sandbox = yield* discover(sandboxUserId);
    expect(sandbox.sourceControlProviders[0]).toMatchObject({
      kind: "github",
      status: "available",
      installHint: "Connect GitHub to import its repositories.",
    });
  });
});

describe("GitHub-backed drives", () => {
  it.effect("connect, import, work on a thread's branch, push it and open a pull request", () => {
    const remote = setup();
    const github = makeFakeGitHub({
      bare: remote.bare,
      repository: "owner/repo",
      defaultBranch: "main",
    });
    const cloud = makeMemoryCloud({ github: github.layer });
    const { drives } = cloud;
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });

      // Connecting: WorkOS runs GitHub's consent and comes back with the attempt's state,
      // and the grant works once.
      const started = yield* user.beginGitHubConnect({ grantId: "g1", returnTo: REDIRECT });
      if (started._tag !== "started") return expect.unreachable();
      expect(yield* user.githubAccessToken()).toBeNull();
      // Without GitHub, agents commit as Signalbox's fallback.
      expect(yield* user.githubCommitAuthor()).toBeNull();
      expect(github.authorize(userId)).toBe(REDIRECT);
      expect(yield* user.completeGitHubConnect("g1")).toEqual({
        _tag: "connected",
        login: "octo",
      });
      expect((yield* user.completeGitHubConnect("g1"))._tag).toBe("failed");
      expect(yield* user.githubAccessToken()).toBe(`gho_${userId}`);
      // Their agents' commits are theirs on GitHub, at the noreply address that links them.
      expect(yield* user.githubCommitAuthor()).toEqual({
        name: "Octo Cat",
        email: "1+octo@users.noreply.github.com",
      });

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

      // Scratch is a folder, not a repository: the git panel reads that, not a failure.
      const scratch = Environment.scratchProject.workspaceRoot;
      const notARepository = { isRepo: false, refName: null, hasWorkingTreeChanges: false };
      expect(
        yield* rpc[WS_METHODS.subscribeVcsStatus]({ cwd: scratch }).pipe(
          Stream.take(1),
          Stream.runHead,
        ),
      ).toMatchObject(Option.some({ _tag: "snapshot", local: notARepository, remote: null }));
      expect(yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: scratch })).toMatchObject({
        ...notARepository,
        pr: null,
      });

      const discovered = yield* rpc[WS_METHODS.serverDiscoverSourceControl]({});
      expect(discovered.sourceControlProviders[0]).toMatchObject({
        kind: "github",
        status: "available",
        auth: { status: "authenticated", account: Option.some("octo") },
      });
      const missing = yield* rpc[WS_METHODS.sourceControlLookupRepository]({
        provider: SourceControlProviderKind.make("github"),
        repository: "owner/elsewhere",
      }).pipe(Effect.flip);
      expect(missing.message).toContain("Authorized OAuth Apps");
      // "Add project" offers what the connection can reach.
      const listed = yield* rpc[SIGNALBOX_REPOSITORIES_WS_METHODS.list]({
        provider: SourceControlProviderKind.make("github"),
      });
      expect(listed.repositories.map((repository) => repository.nameWithOwner)).toEqual([
        "owner/repo",
      ]);

      // Importing makes the repository a drive at once; nothing is cloned. The cloud names
      // the project, so clients follow the id it answers with.
      const imported = yield* rpc[WS_METHODS.projectCloneStart]({
        projectId,
        title: "repo",
        createdAt: "2026-10-08T10:00:00.000Z",
        remoteUrl: "https://github.com/owner/repo.git",
        destinationPath: "~/repo",
      });
      const driveId = imported.cwd.slice("/drives/".length);
      expect(driveId).toMatch(/^shared\/personal\/[0-9a-f]{32}$/);
      expect(imported.projectId).toBe(`drive:${driveId}`);
      const shell = yield* user.shellSnapshot();
      expect(shell.projects.find((project) => project.id === imported.projectId)).toMatchObject({
        title: "owner/repo",
        workspaceRoot: imported.cwd,
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
        projectId: imported.projectId,
        title: "Make the app say hi",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      expect(launched.projection.thread).toMatchObject({
        branch: "signalbox/0000abcd",
        worktreePath: `${imported.cwd}/threads/${threadId}`,
      });
      const cwd = launched.projection.thread.worktreePath!;

      // What the thread's Runner does in its turn: mirror the remote's head, commit, auto-save.
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

  it.effect("a thread's agent publishes its own branch, as the git panel does", () => {
    const remote = setup();
    const github = makeFakeGitHub({
      bare: remote.bare,
      repository: "owner/repo",
      defaultBranch: "main",
    });
    const cloud = makeMemoryCloud({ github: github.layer });
    const otherThread = ThreadId.make("thread-1111efgh");
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
        projectId,
        title: "repo",
        createdAt: "2026-10-08T10:00:00.000Z",
        remoteUrl: "https://github.com/owner/repo.git",
        destinationPath: "~/repo",
      });
      const driveId = imported.cwd.slice("/drives/".length);
      const launch = (id: ThreadId, title: string) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make(`launch-${id}`),
          threadId: id,
          projectId: imported.projectId,
          title,
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
      const cwd = (yield* launch(threadId, "Make the app say hi")).projection.thread.worktreePath!;
      yield* launch(otherThread, "Something else");

      // The thread's Runner saved its branch, as `push` and `create_pr` do before asking.
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
      NodeFS.writeFileSync(NodePath.join(remote.machine, "src/app.ts"), "export const hi = 1;\n");
      git(remote.machine, ["commit", "-qam", "Say hi"]);
      const turn = git(remote.machine, ["rev-parse", "HEAD"]);
      yield* uploadPack({ driveId, threadId, ...remote.pack([turn], [remote.head]) });
      yield* handle.updateRefs(writer, [
        { name: threadRef(threadId), old: remote.head, new: turn },
      ]);

      // What the drive route does once the drive token checks out: the thread is the token's.
      const publish = (thread: ThreadId, body: Record<string, unknown>, live = true) =>
        Effect.gen(function* () {
          const response = yield* serveBranchRequest(
            { userId, threadId: thread, driveId, live },
            JSON.stringify(body),
          );
          const text = yield* Effect.promise(() => response.text());
          return response.status === 200
            ? branchJson.publish.decode(text)
            : ({ status: response.status, text } as const);
        });

      expect(yield* publish(threadId, { action: "push" }, false)).toEqual({
        status: 403,
        text: "Only a running turn publishes its branch.",
      });
      expect(yield* publish(threadId, { action: "merge" })).toMatchObject({ status: 400 });
      // Another thread's token publishes that thread's branch, never this one's.
      expect(yield* publish(otherThread, { action: "push" })).toMatchObject({
        _tag: "failed",
        reason: "nothing_saved",
      } satisfies Partial<PublishResult>);
      expect(github.head("signalbox/0000abcd")).toBeNull();
      expect(github.calls.some((call) => call.includes("git-receive-pack"))).toBe(false);

      expect(
        yield* publish(threadId, {
          action: "create_pr",
          title: "Say hi from the app",
          body: "The app greets you now.",
          draft: true,
        }),
      ).toEqual({
        _tag: "published",
        branch: "signalbox/0000abcd",
        repository: "owner/repo",
        pushed: true,
        pullRequest: {
          number: 1,
          url: "https://github.test/owner/repo/pull/1",
          title: "Say hi from the app",
          baseBranch: "main",
          created: true,
        },
      } satisfies PublishResult);
      expect(github.head("signalbox/0000abcd")).toBe(turn);
      expect(github.pulls[0]).toMatchObject({
        head: "signalbox/0000abcd",
        base: "main",
        body: "The app greets you now.",
        draft: true,
      });
      // The git panel sees the same branch and pull request.
      expect(
        yield* rpc[WS_METHODS.subscribeVcsStatus]({ cwd }).pipe(Stream.take(1), Stream.runHead),
      ).toMatchObject(
        Option.some({
          local: { refName: "signalbox/0000abcd" },
          remote: { hasUpstream: true, aheadCount: 0, pr: { number: 1, isDraft: true } },
        }),
      );
      // Asking again changes nothing.
      expect(yield* publish(threadId, { action: "create_pr" })).toMatchObject({
        _tag: "published",
        pushed: false,
        pullRequest: { number: 1, created: false },
      });

      // Someone pushed to the branch on GitHub: the thread's push would drop their commit.
      const theirs = git(remote.bare, [
        "commit-tree",
        `${turn}^{tree}`,
        "-p",
        turn,
        "-m",
        "Theirs",
      ]);
      git(remote.bare, ["update-ref", "refs/heads/signalbox/0000abcd", theirs]);
      NodeFS.writeFileSync(NodePath.join(remote.machine, "src/app.ts"), "export const hi = 2;\n");
      git(remote.machine, ["commit", "-qam", "Say hi again"]);
      const next = git(remote.machine, ["rev-parse", "HEAD"]);
      yield* uploadPack({ driveId, threadId, ...remote.pack([next], [turn]) });
      yield* handle.updateRefs(writer, [{ name: threadRef(threadId), old: turn, new: next }]);
      expect(yield* publish(threadId, { action: "push" })).toMatchObject({
        _tag: "failed",
        reason: "branch_conflict",
      });
      expect(github.head("signalbox/0000abcd")).toBe(theirs);
      // A lease on a head GitHub has since moved past replaces nothing.
      expect(yield* publish(threadId, { action: "push", lease: turn })).toMatchObject({
        _tag: "failed",
        reason: "branch_conflict",
      });
      // The thread took exactly that head in (fetched, then rebased): its branch replaces it.
      expect(yield* publish(threadId, { action: "push", lease: theirs })).toMatchObject({
        _tag: "published",
        pushed: true,
      });
      expect(github.head("signalbox/0000abcd")).toBe(next);

      yield* user.disconnectGitHub();
      expect(yield* publish(threadId, { action: "push" })).toEqual({
        _tag: "failed",
        reason: "not_connected",
        message: "Connect GitHub first: Settings › Source Control.",
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(cloud.drives.layer, github.layer)),
      Effect.provideService(UserDirectory, cloud.userDirectory),
    );
  });

  it.effect("reads a drive's promised files from GitHub as the reader, with their sizes", () => {
    const remote = setup();
    const github = makeFakeGitHub({
      bare: remote.bare,
      repository: "owner/repo",
      defaultBranch: "main",
    });
    const cloud = makeMemoryCloud({ github: github.layer });
    return Effect.gen(function* () {
      const driveId = "shared/personal/0123456789abcdef0123456789abcdef";
      const handle = (yield* DriveDirectory).forDrive(driveId);
      yield* handle.setRemote({
        provider: "github",
        repository: "owner/repo",
        defaultBranch: "main",
      });
      const api = (yield* GitHub).api;
      const sizes = yield* api.fileSizes("gho_user_1", "owner/repo", remote.head);
      const readme = git(remote.machine, ["rev-parse", `${remote.head}:README.md`]);
      const app = git(remote.machine, ["rev-parse", `${remote.head}:src/app.ts`]);
      expect(sizes).toEqual(
        new Map([
          [readme, 6],
          [app, 10],
        ]),
      );
      yield* uploadPack({
        driveId,
        threadId,
        ...remote.pack([remote.head], [], "blob:none"),
        remoteHead: remote.head,
        promisedSizes: Effect.succeed(sizes),
      });

      // Not connected: the file says where it's kept, rather than failing blind.
      const offline = yield* makeDriveReader(
        driveId,
        yield* makeRemoteFiles(driveId, Effect.succeed(null)),
      );
      expect((yield* offline.blob(app).pipe(Effect.flip)).message).toMatch(/owner\/repo/);
      const reader = yield* makeDriveReader(
        driveId,
        yield* makeRemoteFiles(driveId, Effect.succeed("gho_user_1")),
      );
      expect(new TextDecoder().decode(yield* reader.blob(readme))).toBe("hello\n");
      expect(yield* reader.sizes([readme, app])).toEqual(
        new Map([
          [readme, 6],
          [app, 10],
        ]),
      );
      expect(github.calls.filter((call) => call.includes("/git/blobs/"))).toHaveLength(1);
    }).pipe(
      Effect.provide(Layer.mergeAll(cloud.drives.layer, github.layer)),
      Effect.provideService(UserDirectory, cloud.userDirectory),
    );
  });

  it.effect("asks Pipes for tokens, and forgets connections WorkOS can't use", () => {
    const remote = setup();
    const github = makeFakeGitHub({
      bare: remote.bare,
      repository: "owner/repo",
      defaultBranch: "main",
    });
    return Effect.gen(function* () {
      const store = yield* UserStore.UserStore;
      yield* store.recordSignIn({ id: userId, email: "a@b.c" });
      const connection = yield* GitHubConnection.GitHubConnection;
      let grants = 0;
      const connect = Effect.gen(function* () {
        const grantId = `g${++grants}`;
        const started = yield* connection.begin({ grantId, returnTo: REDIRECT });
        if (started._tag !== "started") return expect.unreachable();
        github.authorize(userId);
        return yield* connection.complete(grantId);
      });
      expect((yield* connect)._tag).toBe("connected");
      expect(yield* connection.accessToken).toBe(`gho_${userId}`);

      // A burst of requests reuses the token; a few minutes later Pipes is asked again.
      const asked = () => github.calls.filter((call) => call.endsWith("/token")).length;
      const before = asked();
      expect(yield* connection.accessToken).toBe(`gho_${userId}`);
      expect(asked()).toBe(before);
      yield* TestClock.adjust("6 minutes");

      // An outage is not a refusal: the connection stays for the next try.
      github.settings.workosOutage = true;
      expect((yield* connection.accessToken.pipe(Effect.flip))._tag).toBe("GitHubError");
      expect(yield* connection.account).toEqual({ login: "octo" });
      github.settings.workosOutage = false;

      // Revoked on GitHub: WorkOS can't refresh it, so it's gone until the user connects again.
      github.revoke(userId);
      expect(yield* connection.accessToken).toBeNull();
      expect(yield* connection.account).toBeNull();

      // A return in another browser throws the attempt away, along with what WorkOS stored.
      yield* connection.begin({ grantId: "stray", returnTo: REDIRECT });
      github.authorize(userId);
      yield* connection.abort("stray");
      expect(github.isConnected(userId)).toBe(false);
      expect((yield* connection.complete("stray"))._tag).toBe("failed");
      expect(yield* connection.accessToken).toBeNull();

      // Even when whoever sent the link out completed it first.
      expect((yield* connect)._tag).toBe("connected");
      yield* connection.abort(`g${grants}`);
      expect(github.isConnected(userId)).toBe(false);
      expect(yield* connection.accessToken).toBeNull();

      // Disconnecting forgets it here and in WorkOS.
      expect((yield* connect)._tag).toBe("connected");
      yield* connection.disconnect;
      expect(github.isConnected(userId)).toBe(false);
      expect(yield* connection.accessToken).toBeNull();
    }).pipe(
      Effect.provide(
        GitHubConnection.layer.pipe(
          Layer.provideMerge(github.layer),
          Layer.provideMerge(UserStore.layer),
          Layer.provideMerge(Layer.effectDiscard(UserStore.migrate)),
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
          ),
        ),
      ),
    );
  });
});
