// @effect-diagnostics nodeBuiltinImport:off - GitHub's side is a real bare repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { operations } from "@signalbox/api/catalog";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { callOperation } from "../api/apiCall.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { threadRef, wipRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { GitHub } from "./GitHub.ts";
import { makeFakeGitHub } from "./githubTesting.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const threadId = ThreadId.make("thread-0000abcd");
const REDIRECT = "http://localhost:8787/api/github/callback";
const SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
];

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
const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/**
 * owner/repo with two commits on main, its bare copy standing in for GitHub,
 * and a thread's machine holding main one commit deep, as a Runner does.
 */
const setupRemote = () => {
  const upstream = makeRepo();
  cleanups.push(upstream.cleanup);
  upstream.write("README.md", "hello\n");
  const first = upstream.commit("first");
  upstream.write("src/app.ts", "export {}\n");
  upstream.commit("second");
  upstream.git(["branch", "-m", "main"]);
  const bare = tempDir("review-bare-");
  git(bare, ["clone", "-q", "--bare", upstream.dir, "."]);
  const machine = tempDir("review-machine-");
  git(machine, ["clone", "-q", "--depth=1", `file://${bare}`, "."]);
  const pack = (include: ReadonlyArray<string>, exclude: ReadonlyArray<string> = []) => {
    const out = tempDir("review-pack-");
    const name = NodeChildProcess.execFileSync(
      "git",
      ["pack-objects", "--revs", "--delta-base-offset", NodePath.join(out, "pack")],
      {
        cwd: machine,
        env: GIT_ENV,
        input: [...include, ...exclude.map((oid) => `^${oid}`)].join("\n") + "\n",
        encoding: "utf8",
      },
    ).trim();
    const read = (ext: string): Uint8Array<ArrayBuffer> =>
      new Uint8Array(NodeFS.readFileSync(NodePath.join(out, `pack-${name}.${ext}`)));
    return { pack: read("pack"), idx: read("idx") };
  };
  /** A commit on `branch` on GitHub, made upstream and pushed: someone else's work. */
  const pushUpstream = (branch: string, from: string, file: string, text: string) => {
    // Start from GitHub's copy: pull requests merged there move its branches.
    upstream.git(["fetch", "-q", bare, "+refs/heads/*:refs/remotes/github/*"]);
    upstream.git(["checkout", "-q", "-B", branch, from]);
    upstream.write(file, text);
    const oid = upstream.commit(`${file} on ${branch}`);
    upstream.git(["push", "-q", "-f", bare, `${branch}:${branch}`]);
    return oid;
  };
  const commit = (file: string, text: string, message: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(machine, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(machine, file), text);
    git(machine, ["add", "-A"]);
    git(machine, ["commit", "-qm", message]);
    return git(machine, ["rev-parse", "HEAD"]);
  };
  /** What the Runner does to take in GitHub's `main`: fetch its head, deep enough to merge. */
  const fetchMain = () => {
    git(machine, ["fetch", "-q", "--depth=2", "origin", "main"]);
    return git(machine, ["rev-parse", "FETCH_HEAD"]);
  };
  return {
    bare,
    fetchMain,
    machine,
    pack,
    commit,
    pushUpstream,
    first,
    head: git(machine, ["rev-parse", "HEAD"]),
  };
};

/** An imported repository with one thread whose Runner committed a turn and auto-saved a draft. */
const prepare = Effect.fn("prepare")(function* (
  remote: ReturnType<typeof setupRemote>,
  cloud: ReturnType<typeof makeMemoryCloud>,
  github: ReturnType<typeof makeFakeGitHub>,
) {
  const user = cloud.userDirectory.forUser(userId);
  yield* user.recordSignIn({ id: userId, email: "a@b.c" });
  yield* user.beginGitHubConnect({ grantId: "g1", returnTo: REDIRECT });
  github.authorize(userId);
  yield* user.completeGitHubConnect("g1");
  yield* cloud.userDirectory.forUser("user_2").recordSignIn({ id: "user_2", email: "x@y.z" });
  const clientFor = (who: string) =>
    RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId: who, sid: "test-session" }),
          CloudRpc.layerScopeAuthorization(SCOPES),
        ).pipe(Layer.provide(cloud.layerFor(who))),
      ),
    );
  const rpc = yield* clientFor(userId);
  const imported = yield* rpc[WS_METHODS.projectCloneStart]({
    projectId: ProjectId.make("project-from-the-client"),
    title: "repo",
    createdAt: "2026-10-08T10:00:00.000Z",
    remoteUrl: "https://github.com/owner/repo.git",
    destinationPath: "~/repo",
  });
  const driveId = imported.cwd.slice("/drives/".length);
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
  const cwd = launched.projection.thread.worktreePath!;
  const branch = launched.projection.thread.branch!;

  const handle = (yield* DriveDirectory).forDrive(driveId);
  const writer = { threadId, userId, generation: 1, live: true, packsAfter: 0 };
  yield* uploadPack({ driveId, threadId, ...remote.pack([remote.head]), remoteHead: remote.head });
  yield* handle.mirror(writer, { expectedMain: null, newMain: remote.head });
  yield* handle.open(writer);
  /** The Runner commits a turn: the branch and its auto-save both move to it. */
  const commitTurn = (previous: string, file: string, text: string) =>
    Effect.gen(function* () {
      const turn = remote.commit(file, text, `Edit ${file}`);
      yield* uploadPack({ driveId, threadId, ...remote.pack([turn], [previous]) });
      yield* handle.updateRefs(writer, [
        { name: threadRef(threadId), old: previous, new: turn },
        { name: wipRef(threadId), old: (yield* handle.refs(threadId)).wip, new: turn },
      ]);
      return turn;
    });
  /** The Runner takes in a remote head, kept without its parents. */
  const takeInRemote = (oid: string, previous: string) =>
    uploadPack({ driveId, threadId, ...remote.pack([oid], [previous]), remoteHead: oid });
  /** The Runner commits a merge of `other` into the branch. */
  const mergeTurn = (previous: string, other: string) =>
    Effect.gen(function* () {
      git(remote.machine, ["merge", "-q", "--no-edit", other]);
      const merged = git(remote.machine, ["rev-parse", "HEAD"]);
      yield* uploadPack({ driveId, threadId, ...remote.pack([merged], [previous, other]) });
      yield* handle.updateRefs(writer, [
        { name: threadRef(threadId), old: previous, new: merged },
        { name: wipRef(threadId), old: (yield* handle.refs(threadId)).wip, new: merged },
      ]);
      return merged;
    });
  /** The Runner auto-saves mid-turn: only `wip` moves. */
  const autosave = (turn: string, file: string, text: string) =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(NodePath.join(remote.machine, file), text);
      git(remote.machine, ["add", "-A"]);
      const saved = git(remote.machine, [
        "commit-tree",
        git(remote.machine, ["write-tree"]),
        "-p",
        turn,
        "-m",
        "Auto-save",
      ]);
      git(remote.machine, ["reset", "-q", "--hard", turn]);
      yield* uploadPack({ driveId, threadId, ...remote.pack([saved], [turn]) });
      yield* handle.updateRefs(writer, [
        { name: wipRef(threadId), old: (yield* handle.refs(threadId)).wip, new: saved },
      ]);
      return saved;
    });
  const preview = (input: Omit<ReviewDiffPreviewInput, "cwd"> = {}, who = userId) =>
    Effect.flatMap(clientFor(who), (client) =>
      client[WS_METHODS.reviewGetDiffPreview]({ cwd, ...input }),
    );
  const source = (result: ReviewDiffPreviewResult, kind: string) =>
    result.sources.find((candidate) => candidate.kind === kind);
  const status = () =>
    rpc[WS_METHODS.subscribeVcsStatus]({ cwd }).pipe(Stream.take(1), Stream.runHead);
  return {
    rpc,
    cwd,
    branch,
    driveId,
    commitTurn,
    takeInRemote,
    mergeTurn,
    autosave,
    preview,
    source,
    status,
  };
});

const run = <A, E, R>(
  body: (
    env: Effect.Success<ReturnType<typeof prepare>> & {
      readonly remote: ReturnType<typeof setupRemote>;
      readonly github: ReturnType<typeof makeFakeGitHub>;
      readonly cloud: ReturnType<typeof makeMemoryCloud>;
    },
  ) => Effect.Effect<A, E, R>,
) => {
  const remote = setupRemote();
  const github = makeFakeGitHub({
    bare: remote.bare,
    repository: "owner/repo",
    defaultBranch: "main",
  });
  const cloud = makeMemoryCloud({ github: github.layer });
  return Effect.gen(function* () {
    const env = yield* prepare(remote, cloud, github);
    return yield* body({ ...env, remote, github, cloud });
  }).pipe(Effect.provide(Layer.mergeAll(cloud.drives.layer, github.layer)));
};

describe("reviewing a thread's branch in the cloud", () => {
  it.effect("shows every committed turn against main, and the unsaved draft apart", () =>
    run(({ remote, commitTurn, autosave, preview, source, status, branch }) =>
      Effect.gen(function* () {
        const first = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        const second = yield* commitTurn(first, "README.md", "hello there\n");
        const saved = yield* autosave(second, "draft.md", "unsaved idea\n");

        const result = yield* preview();
        const changes = source(result, "branch-range");
        expect(changes).toMatchObject({
          title: "Changes vs main",
          baseRef: "main",
          headRef: branch,
          truncated: false,
          revision: { baseSha: remote.head, headSha: second },
          files: [
            { path: "README.md", previousPath: null, additions: 1, deletions: 1 },
            { path: "src/app.ts", previousPath: null, additions: 1, deletions: 1 },
          ],
        });
        // Both turns, not just the latest; never the unsaved draft.
        expect(changes?.diff).toContain("+export const hi = 1;");
        expect(changes?.diff).not.toContain("draft.md");
        expect(source(result, "working-tree")).toMatchObject({
          title: "Uncommitted",
          revision: { baseSha: second, headSha: saved },
          files: [{ path: "draft.md", additions: 1, deletions: 0 }],
        });

        // The details card counts the same committed changes.
        expect(yield* status()).toMatchObject({
          value: { local: { branchChanges: { baseRef: "main", insertions: 2, deletions: 2 } } },
        });
      }),
    ),
  );

  it.effect("keeps autosaved changes visible when GitHub is disconnected", () =>
    run(({ remote, commitTurn, autosave, status, github, cloud }) =>
      Effect.gen(function* () {
        const turn = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        yield* autosave(turn, "draft.md", "unsaved idea\n");
        yield* cloud.userDirectory.forUser(userId).disconnectGitHub();
        const calls = github.calls.length;

        const result = yield* status();
        expect(result).toMatchObject({
          value: {
            local: {
              hasWorkingTreeChanges: true,
              workingTree: { files: [{ path: "draft.md" }] },
              branchChangesError: "Connect GitHub first: Settings › Source Control.",
            },
            remote: null,
          },
        });
        if (result._tag === "None") return expect.unreachable();
        expect(result.value.local).not.toHaveProperty("branchChanges");
        expect(github.calls).toHaveLength(calls);
      }),
    ),
  );

  it.effect("leaves out what main gained after the branch forked, pushed or not", () =>
    run(({ remote, rpc, cwd, commitTurn, preview, source }) =>
      Effect.gen(function* () {
        const turn = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        remote.pushUpstream("main", "main", "elsewhere.md", "someone else's work\n");
        const check = Effect.gen(function* () {
          const changes = source(yield* preview(), "branch-range");
          expect(changes).toMatchObject({
            title: "Changes vs main",
            revision: { baseSha: remote.head, headSha: turn },
            files: [{ path: "src/app.ts" }],
          });
        });
        // Unpushed: GitHub only knows the commit the branch is built on.
        yield* check;
        yield* rpc[WS_METHODS.gitRunStackedAction]({
          actionId: "push-1",
          cwd,
          action: "push",
          threadId,
        }).pipe(Stream.runDrain);
        // Pushed: GitHub compares the branch's head itself.
        yield* check;
      }),
    ),
  );

  it.effect("starts from work main already merged when only newer commits are unpushed", () =>
    run(({ remote, github, rpc, cwd, commitTurn, preview, source, branch }) =>
      Effect.gen(function* () {
        // A-B-C on the branch: B was pushed and merged, then main moved on to D.
        const merged = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        yield* rpc[WS_METHODS.gitRunStackedAction]({
          actionId: "push-1",
          cwd,
          action: "create_pr",
          threadId,
        }).pipe(Stream.runDrain);
        github.merge(1);
        remote.pushUpstream("main", "github/main", "elsewhere.md", "someone else's work\n");
        // Pushing C would move the branch on GitHub: C stays the drive's alone.
        const latest = yield* commitTurn(merged, "README.md", "hello there\n");
        expect(github.head(branch)).toBe(merged);

        const changes = source(yield* preview(), "branch-range");
        expect(changes).toMatchObject({
          revision: { baseSha: merged, headSha: latest },
          files: [{ path: "README.md" }],
        });
      }),
    ),
  );

  it.effect("finds the newest base a branch merged in, after main moved again", () =>
    run(({ remote, commitTurn, takeInRemote, mergeTurn, preview, source }) =>
      Effect.gen(function* () {
        const turn = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        remote.pushUpstream("main", "github/main", "middle.md", "main moved\n");
        const middle = remote.fetchMain();
        yield* takeInRemote(middle, remote.head);
        const merged = yield* mergeTurn(turn, middle);
        remote.pushUpstream("main", "github/main", "late.md", "main moved again\n");

        const changes = source(yield* preview(), "branch-range");
        expect(changes).toMatchObject({
          revision: { baseSha: middle, headSha: merged },
          files: [{ path: "src/app.ts" }],
        });
      }),
    ),
  );

  it.effect("compares against the pull request's base, or the base asked for", () =>
    run(({ remote, github, rpc, cwd, commitTurn, preview, source, status, branch }) =>
      Effect.gen(function* () {
        const turn = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        const release = remote.pushUpstream("release", remote.head, "notes.md", "release\n");
        yield* rpc[WS_METHODS.gitRunStackedAction]({
          actionId: "push-1",
          cwd,
          action: "push",
          threadId,
        }).pipe(Stream.runDrain);
        const api = (yield* GitHub).api;
        yield* api.createPull(`gho_${userId}`, "owner/repo", {
          title: "Say hi",
          head: branch,
          base: "release",
          body: "",
        });
        const viaPullRequest = source(yield* preview(), "branch-range");
        expect(viaPullRequest).toMatchObject({
          title: "Changes vs release",
          baseRef: "release",
          revision: { baseSha: remote.head, headSha: turn },
          files: [{ path: "src/app.ts" }],
        });
        expect(release).not.toBe(remote.head);
        expect(yield* status()).toMatchObject({
          value: { local: { branchChanges: { baseRef: "release" } } },
        });
        // The picker names remote branches `origin/…`.
        const picked = source(yield* preview({ baseRef: "origin/main" }), "branch-range");
        expect(picked).toMatchObject({ title: "Changes vs main", baseRef: "main" });
        expect(github.calls.some((call) => call.includes("/compare/"))).toBe(true);
      }),
    ),
  );

  it.effect("reads one file and its contents at the commits the preview showed", () =>
    run(({ remote, rpc, cwd, commitTurn, preview, source }) =>
      Effect.gen(function* () {
        const first = yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        const shown = source(yield* preview(), "branch-range")!;
        const revision = shown.revision!;
        // The thread moves on after the preview was read.
        yield* commitTurn(first, "src/app.ts", "export const hi = 2;\n");
        const file = yield* preview({
          file: {
            path: "src/app.ts",
            previousPath: null,
            sourceKind: "branch-range",
            revision,
          },
        });
        expect(file.sources).toHaveLength(1);
        expect(file.sources[0]!.diff).toContain("+export const hi = 1;");
        expect(file.sources[0]!.diffHash).not.toBe(shown.diffHash);
        expect(
          yield* rpc[WS_METHODS.reviewGetDiffFileContents]({
            cwd,
            sourceKind: "branch-range",
            changeType: "change",
            baseRef: revision.baseSha,
            headRef: revision.headSha,
            oldPath: "src/app.ts",
            newPath: "src/app.ts",
          }),
        ).toEqual({ oldContents: "export {}\n", newContents: "export const hi = 1;\n" });
        // A commit the drive doesn't hold reads nothing.
        const unknown = yield* preview({
          file: {
            path: "src/app.ts",
            previousPath: null,
            sourceKind: "branch-range",
            revision: { baseSha: "f".repeat(40), headSha: revision.headSha },
          },
        }).pipe(Effect.flip);
        expect(unknown).toMatchObject({ _tag: "GitCommandError" });
      }),
    ),
  );

  it.effect("says why when the base or where the branch left it is unknown", () =>
    run(({ remote, commitTurn, preview }) =>
      Effect.gen(function* () {
        yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        const missing = yield* preview({ baseRef: "nope" }).pipe(Effect.flip);
        expect(missing).toMatchObject({ detail: "nope isn't a branch on GitHub." });
        // `old` forked from history the drive holds only on GitHub.
        remote.pushUpstream("old", remote.first, "old.md", "old\n");
        const split = yield* preview({ baseRef: "old" }).pipe(Effect.flip);
        expect(split).toMatchObject({ _tag: "GitCommandError" });
        expect(split.message).toContain("doesn't hold");
      }),
    ),
  );

  it.effect("serves the API, and nothing to someone who can't open the folder", () =>
    run(({ remote, cloud, rpc, cwd, commitTurn, preview }) =>
      Effect.gen(function* () {
        yield* commitTurn(remote.head, "src/app.ts", "export const hi = 1;\n");
        const operation = operations.find((entry) => entry.name === "review.getDiffPreview")!;
        const answer = yield* callOperation({
          operation,
          body: { cwd },
          caller: { userId, kind: "person", scopes: SCOPES, credentialId: "key-1" },
          identity,
          follow: false,
        }).pipe(Effect.provide(cloud.layerFor(userId)));
        expect(answer).toMatchObject({
          _tag: "json",
          status: 200,
          body: {
            sources: [{ kind: "working-tree" }, { kind: "branch-range", title: "Changes vs main" }],
          },
        });
        // The thread's id under another folder names no branch of it there.
        const elsewhere = yield* rpc[WS_METHODS.reviewGetDiffPreview]({
          cwd: `/drives/my/personal/${userId}/threads/${threadId}`,
        }).pipe(Effect.orElseSucceed(() => ({ sources: [] })));
        expect(elsewhere.sources).toEqual([]);
        const outsider = yield* preview({}, "user_2").pipe(Effect.flip);
        expect(outsider).toMatchObject({ _tag: "GitCommandError" });
        expect(JSON.stringify(outsider)).not.toContain("hi = 1");
      }),
    ),
  );
});
