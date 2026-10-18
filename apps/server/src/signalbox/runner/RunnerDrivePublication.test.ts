// @effect-diagnostics nodeBuiltinImport:off - these tests run real git in temporary directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  threadRemoteBranch,
  type DriveState,
  type RefWriteResult,
} from "@signalbox/runner-protocol/DriveProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { git, makeFakeDrive, read, scopedTest, status, write } from "./driveTesting.ts";
import { makeRunnerDrive } from "./RunnerDrive.ts";
import type { DriveClient } from "./RunnerDriveClient.ts";

/** The same drive gains a remote after its main has been copied into a new repository. */
const publishable = (root: string) => {
  const upstream = NodePath.join(root, "github");
  NodeFS.mkdirSync(upstream);
  git(upstream, "init", "-q", "--bare", "--initial-branch=main");
  const drive = makeFakeDrive(root, { upstream });
  let published = false;
  const state = (value: DriveState): DriveState => ({
    ...value,
    remote: published ? value.remote : null,
  });
  const reply = (value: RefWriteResult): RefWriteResult =>
    value._tag === "refused" ? value : { ...value, state: state(value.state) };
  const client = (threadId: string): DriveClient => {
    const original = drive.client(threadId);
    return {
      ...original,
      open: original.open.pipe(Effect.map(state)),
      state: original.state.pipe(Effect.map(state)),
      updateRefs: (input) => original.updateRefs(input).pipe(Effect.map(reply)),
      reconcile: (input) => original.reconcile(input).pipe(Effect.map(reply)),
      mirror: (input) => original.mirror(input).pipe(Effect.map(reply)),
      recordCheckpoint: (input) => original.recordCheckpoint(input).pipe(Effect.map(reply)),
    };
  };
  const machine = (name: string, threadId = "old-thread") => {
    const cwd = NodePath.join(root, name, threadId);
    return makeRunnerDrive({
      cwd,
      client: client(threadId),
      branch: threadRemoteBranch(threadId),
    }).pipe(Effect.map((runner) => ({ runner, cwd })));
  };
  return {
    drive,
    machine,
    publish: () => {
      git(upstream, "fetch", "-q", drive.store, `${drive.refs("old-thread").main}:refs/heads/main`);
      published = true;
    },
  };
};

describe("RunnerDrive publication", () => {
  it.effect(
    "adopts the remote next turn without replacing dirty files, history or checkpoint notes",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const fixture = publishable(root);
          const { runner, cwd } = yield* fixture.machine("vm-1");
          yield* runner.prepare("token");
          write(cwd, "work.txt", "first turn\n");
          const first = yield* runner.finishTurn();
          const checkpoint = first.checkpoint!;
          yield* runner.recordCheckpoint({
            threadId: "old-thread",
            runId: "run-1",
            turnId: "turn-1",
            commit: checkpoint.commit,
            start: checkpoint.start,
            views: { shortcuts: [], context: null },
          });
          const notes = git(cwd, "notes", "show", checkpoint.commit);
          fixture.publish();
          write(cwd, "work.txt", "staged before publication\n");
          git(cwd, "add", "work.txt");
          write(cwd, "work.txt", "unstaged before publication\n");
          write(cwd, "new.txt", "untracked before publication\n");
          const dirty = status(cwd);
          const index = git(cwd, "write-tree");
          yield* runner.prepare("token");
          expect(git(cwd, "rev-parse", "--show-toplevel")).toBe(NodeFS.realpathSync(cwd));
          expect(git(cwd, "rev-parse", "HEAD")).toBe(checkpoint.commit);
          expect(status(cwd)).toEqual(dirty);
          expect(git(cwd, "write-tree")).toBe(index);
          expect(read(cwd, "work.txt")).toBe("unstaged before publication\n");
          expect(git(cwd, "notes", "show", checkpoint.commit)).toBe(notes);
          expect(git(cwd, "config", "branch.signalbox.merge")).toBe(
            `refs/heads/${threadRemoteBranch("old-thread")}`,
          );

          const saved = yield* runner.finishTurn();
          expect(saved.outcome._tag).toBe("saved");
          expect(fixture.drive.refs("old-thread").main).toBe(checkpoint.commit);
          expect(git(cwd, "merge-base", checkpoint.commit, saved.checkpoint!.commit)).toBe(
            checkpoint.commit,
          );

          const restarted = yield* fixture.machine("vm-1");
          yield* restarted.runner.prepare("token");
          expect(read(restarted.cwd, "new.txt")).toBe("untracked before publication\n");
          const replacement = yield* fixture.machine("vm-2");
          yield* replacement.runner.prepare("token");
          expect(git(replacement.cwd, "rev-parse", "HEAD")).toBe(saved.checkpoint!.commit);
          expect(read(replacement.cwd, "work.txt")).toBe("unstaged before publication\n");
          expect(git(replacement.cwd, "notes", "show", checkpoint.commit)).toBe(notes);
          expect(fixture.drive.checkpoints("old-thread")).toHaveLength(1);

          const fresh = yield* fixture.machine("vm-3", "fresh-thread");
          yield* fresh.runner.prepare("token");
          expect(read(fresh.cwd, "work.txt")).toBe("first turn\n");
          expect(git(fresh.cwd, "config", "branch.signalbox.merge")).toBe(
            `refs/heads/${threadRemoteBranch("fresh-thread")}`,
          );

          fixture.drive.pinToCheckpoint("old-thread", checkpoint.commit, {
            shortcuts: [],
            context: null,
          });
          yield* replacement.runner.prepare("token");
          expect(git(replacement.cwd, "rev-parse", "HEAD")).toBe(checkpoint.commit);
          write(replacement.cwd, "continued.txt", "from checkpoint\n");
          expect((yield* replacement.runner.finishTurn()).outcome._tag).toBe("saved");
          expect(fixture.drive.refs("old-thread").main).toBe(checkpoint.commit);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("explicit branch save discovers a remote bound during the active turn", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const fixture = publishable(root);
        const { runner, cwd } = yield* fixture.machine("vm-1");
        yield* runner.prepare("token");
        write(cwd, "work.txt", "local\n");
        const first = yield* runner.finishTurn();
        yield* runner.prepare("token");
        fixture.publish();
        write(cwd, "work.txt", "active work\n");
        const saved = yield* runner.saveBranch("Save active work");
        expect(saved._tag).toBe("saved");
        expect(fixture.drive.refs("old-thread").main).toBe(first.checkpoint!.commit);
        expect(
          git(fixture.drive.store, "show", `${fixture.drive.refs("old-thread").thread}:work.txt`),
        ).toBe("active work");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("finishing and continuing a local turn after publication never advances main", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const fixture = publishable(root);
        const { runner, cwd } = yield* fixture.machine("vm-1");
        yield* runner.prepare(null);
        write(cwd, "work.txt", "local\n");
        const first = yield* runner.finishTurn();
        yield* runner.prepare(null);
        fixture.publish();
        write(cwd, "work.txt", "active work\n");
        const finished = yield* runner.finishTurn();
        expect(finished.outcome._tag).toBe("saved");
        expect(fixture.drive.refs("old-thread").main).toBe(first.checkpoint!.commit);
        expect((yield* runner.continueAfterResolution)._tag).toBe("saved");
        yield* runner.prepare(null);
        write(cwd, "work.txt", "without remote credentials\n");
        expect((yield* runner.finishTurn()).outcome._tag).toBe("saved");
        expect(fixture.drive.refs("old-thread").main).toBe(first.checkpoint!.commit);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );
});
