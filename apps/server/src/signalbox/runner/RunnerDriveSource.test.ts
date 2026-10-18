// @effect-diagnostics nodeBuiltinImport:off - the assertions run real git on temp dirs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type DriveState, threadRemoteBranch } from "@signalbox/runner-protocol/DriveProtocol";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { git, gitOk, makeFakeDrive, machine, scopedTest, write } from "./driveTesting.ts";
import type { DriveClient } from "./RunnerDriveClient.ts";

const makeUpstream = (root: string) => {
  const dir = NodePath.join(root, "upstream");
  NodeFS.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  const commit = (file: string, text: string, message: string) => {
    write(dir, file, text);
    git(dir, "add", "-A");
    git(
      dir,
      "-c",
      "user.name=Dev",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-q",
      "-m",
      message,
    );
    return git(dir, "rev-parse", "HEAD");
  };
  commit("README.md", "hello\n", "first");
  commit("src/app.ts", "export {}\n", "second");
  return { dir, commit };
};

const sourceState = (state: DriveState): DriveState =>
  state.remote === null ? state : { ...state, remote: { ...state.remote, mode: "source" } };

const asSourceRemote = (client: DriveClient): DriveClient => ({
  ...client,
  open: client.open.pipe(Effect.map(sourceState)),
  state: client.state.pipe(Effect.map(sourceState)),
});

describe("RunnerDrive source remote", () => {
  it.effect("keeps the borrowed main pinned and lands work without syncing source changes", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const upstream = makeUpstream(root);
        const drive = makeFakeDrive(root, { upstream: upstream.dir });
        const original = yield* machine(drive, root, "vm-original", "t-original");
        yield* original.runner.prepare("remote-token");
        const pinned = git(upstream.dir, "rev-parse", "HEAD");
        expect(drive.refs("t-original").main).toBe(pinned);

        const sourceHead = upstream.commit(
          "src/app.ts",
          "export const upstream = true;\n",
          "Advance source",
        );
        const sourceDrive = {
          ...drive,
          client: (threadId: string) => asSourceRemote(drive.client(threadId)),
        };
        const fork = yield* machine(sourceDrive, root, "vm-fork", "t-fork");
        const mergedPullRequest = {
          host: "github.com",
          repository: "owner/repo",
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
          source: "created",
          linkedAt: "2026-10-16T10:00:00.000Z",
          snapshot: {
            state: "merged",
            title: "Fork",
            headBranch: threadRemoteBranch("t-fork"),
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-16T10:00:00.000Z",
          },
          stack: null,
        } as ThreadPullRequestLink;

        yield* fork.runner.prepare("remote-token", undefined, [], [mergedPullRequest]);

        expect(drive.refs("t-fork")).toMatchObject({
          main: pinned,
          thread: pinned,
          base: pinned,
        });
        expect(drive.calls.mirror).toBe(1);
        expect(git(fork.cwd, "rev-parse", "refs/remotes/origin/main")).toBe(sourceHead);
        expect(git(fork.cwd, "show", `${sourceHead}:src/app.ts`)).toBe(
          "export const upstream = true;",
        );
        expect(git(fork.cwd, "show", `${pinned}:src/app.ts`)).toBe("export {}");
        expect(git(fork.cwd, "rev-parse", "HEAD")).toBe(pinned);
        expect(gitOk(fork.cwd, "merge-base", "--is-ancestor", sourceHead, "HEAD")).toBe(false);

        write(fork.cwd, "fork.md", "private exploration\n");
        const turn = yield* fork.runner.finishTurn();
        expect(turn.outcome._tag).toBe("landed");
        const forkHead = git(fork.cwd, "rev-parse", "HEAD");
        expect(drive.refs("t-fork").main).toBe(forkHead);
        expect(git(fork.cwd, "rev-parse", "HEAD^")).toBe(pinned);
        expect(drive.calls.reconcile).toBe(1);
        expect(drive.calls.mirror).toBe(1);
        expect(git(upstream.dir, "rev-parse", "HEAD")).toBe(sourceHead);
        expect(gitOk(upstream.dir, "show", "HEAD:fork.md")).toBe(false);
        expect(drive.mainFile("fork.md")).toBe("private exploration");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );
});
