// @effect-diagnostics nodeBuiltinImport:off - the assertions run real git on temp dirs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DRIVE_COMMIT_AUTHOR } from "@signalbox/runner-protocol/DriveProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  git,
  gitOk,
  makeFakeDrive,
  machine,
  read,
  scopedTest,
  status,
  write,
} from "./driveTesting.ts";
import { makeRunnerDrive } from "./RunnerDrive.ts";
import { DriveClientError } from "./RunnerDriveClient.ts";

describe("RunnerDrive", () => {
  it.effect(
    "auto-saves the worktree to wip on an empty drive without touching HEAD or the index",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
          // Files already there when the drive first opens become part of it.
          write(cwd, "existing.txt", "was here\n");
          yield* runner.prepare("remote-token");
          expect(read(cwd, "existing.txt")).toBe("was here\n");
          write(cwd, "notes.md", "hello\n");
          yield* runner.autosave;
          yield* runner.flush;

          const wip = drive.refs("t1").wip;
          expect(wip).not.toBeNull();
          expect(drive.packs).toHaveLength(1);
          expect(git(drive.store, "show", `${wip}:notes.md`)).toBe("hello");
          expect(git(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/signalbox");
          expect(gitOk(cwd, "rev-parse", "--verify", "HEAD")).toBe(false);
          expect(git(drive.store, "show", `${wip}:existing.txt`)).toBe("was here");
          expect(status(cwd)).toEqual(["?? existing.txt", "?? notes.md"]);
          expect(git(cwd, "rev-parse", "refs/drive/wip")).toBe(wip);

          // Nothing changed: no new save.
          yield* runner.autosave;
          yield* runner.flush;
          expect(drive.refs("t1").wip).toBe(wip);
          expect(drive.packs).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("has nothing to land when a thread has never saved a file", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const { runner } = yield* machine(drive, root, "vm-1", "t1");
        yield* runner.prepare("remote-token");
        expect(yield* runner.finishTurn({ message: "Hi" })).toEqual({
          checkpoint: null,
          outcome: { _tag: "nothing_saved" },
        });
        expect(drive.refs("t1")).toMatchObject({ main: null, thread: null });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("restores the thread's branch and its auto-save on a brand new machine", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* machine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare("remote-token");
        write(first.cwd, "a.txt", "one\n");
        const turn = yield* first.runner.finishTurn({ message: "Add a\n\nbody" });
        expect(turn.outcome._tag).toBe("landed");
        expect(turn.checkpoint?.files).toEqual([
          { path: "a.txt", kind: "added", additions: 1, deletions: 0 },
        ]);
        expect(git(first.cwd, "log", "-1", "--format=%s")).toBe("Add a");
        write(first.cwd, "a.txt", "one\ntwo\n");
        write(first.cwd, "b.txt", "new\n");
        yield* first.runner.autosave;
        yield* first.runner.flush;

        const second = yield* machine(drive, root, "vm-2", "t1");
        yield* second.runner.prepare("remote-token");
        expect(git(second.cwd, "rev-parse", "HEAD")).toBe(drive.refs("t1").thread);
        expect(git(second.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/signalbox");
        expect(read(second.cwd, "a.txt")).toBe("one\ntwo\n");
        expect(read(second.cwd, "b.txt")).toBe("new\n");
        expect(status(second.cwd)).toEqual([" M a.txt", "?? b.txt"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("commits as the turn's author, and as Signalbox when the turn names none", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
        const ident = (rev: string) => git(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>", rev);
        const octo = "Octo Cat <1+octo@users.noreply.github.com>";

        yield* runner.prepare("remote-token", {
          name: "Octo Cat",
          email: "1+octo@users.noreply.github.com",
        });
        write(cwd, "a.txt", "one\n");
        yield* runner.autosave;
        yield* runner.flush;
        expect(ident(drive.refs("t1").wip!)).toBe(`${octo}|${octo}`);
        yield* runner.finishTurn({ message: "Add a" });
        expect(ident("HEAD")).toBe(`${octo}|${octo}`);

        // A cloud that sends no author, or an owner who disconnected GitHub.
        yield* runner.prepare("remote-token");
        write(cwd, "b.txt", "two\n");
        yield* runner.finishTurn({ message: "Add b" });
        const signalbox = `${DRIVE_COMMIT_AUTHOR.name} <${DRIVE_COMMIT_AUTHOR.email}>`;
        expect(ident("HEAD")).toBe(`${signalbox}|${signalbox}`);
        expect(ident("HEAD^")).toBe(`${octo}|${octo}`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("never saves dependency trees, and checking out leaves them in place", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* machine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare("remote-token");
        // No .gitignore: the drive still keeps the machine's caches out.
        write(first.cwd, "app/package.json", "{}\n");
        write(first.cwd, "app/node_modules/pkg/index.js", "module.exports = 1;\n");
        const turn = yield* first.runner.finishTurn({ message: "Add app" });
        expect(turn.checkpoint?.files.map((file) => file.path)).toEqual(["app/package.json"]);
        expect(git(drive.store, "ls-tree", "-r", "--name-only", drive.refs("t1").thread!)).toBe(
          "app/package.json",
        );

        // Syncing the checkout to the drive's branch keeps the tree on disk.
        git(first.cwd, "update-ref", "-d", "refs/drive/thread");
        yield* first.runner.prepare("remote-token");
        expect(git(first.cwd, "rev-parse", "refs/drive/thread")).toBe(drive.refs("t1").thread);
        expect(read(first.cwd, "app/node_modules/pkg/index.js")).toBe("module.exports = 1;\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("lands two threads' turns on main, in packs that are closed on their own", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const a = yield* machine(drive, root, "vm-a", "ta");
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare("remote-token");
        yield* b.runner.prepare("remote-token");
        write(a.cwd, "a.txt", "from a\n");
        write(b.cwd, "b.txt", "from b\n");
        expect((yield* a.runner.finishTurn({ message: "a" })).outcome._tag).toBe("landed");
        const landed = yield* b.runner.finishTurn({ message: "b" });
        expect(landed.outcome).toEqual({ _tag: "landed", main: drive.refs("tb").main });
        // The checkpoint is the turn's own work, not what merging main brought in.
        expect(landed.checkpoint?.files.map((file) => file.path)).toEqual(["b.txt"]);
        expect(drive.mainFile("a.txt")).toBe("from a");
        expect(drive.mainFile("b.txt")).toBe("from b");

        // A clone from nothing but the drive's packs has all of main.
        const clone = NodePath.join(root, "clone");
        NodeFS.mkdirSync(clone);
        git(clone, "init", "-q");
        for (const file of NodeFS.readdirSync(drive.packDir)) {
          NodeFS.copyFileSync(
            NodePath.join(drive.packDir, file),
            NodePath.join(clone, ".git", "objects", "pack", file),
          );
        }
        const main = drive.refs("tb").main!;
        git(clone, "fsck", "--connectivity-only", "--no-dangling", main);
        expect(git(clone, "show", `${main}:b.txt`)).toBe("from b");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("leaves a conflict to the agent and lands once it is resolved", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const a = yield* machine(drive, root, "vm-a", "ta");
        yield* a.runner.prepare("remote-token");
        write(a.cwd, "shared.txt", "base\n");
        yield* a.runner.finishTurn({ message: "base" });
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare("remote-token");
        yield* b.runner.prepare("remote-token");
        write(a.cwd, "shared.txt", "from a\n");
        write(b.cwd, "shared.txt", "from b\n");
        expect((yield* a.runner.finishTurn({ message: "a" })).outcome._tag).toBe("landed");
        const turn = yield* b.runner.finishTurn({ message: "b" });
        expect(turn.outcome).toEqual({ _tag: "conflict", files: ["shared.txt"] });
        expect(read(b.cwd, "shared.txt")).toContain("<<<<<<< ");

        // Still conflicted: the merge stays in progress.
        expect(yield* b.runner.continueAfterResolution).toEqual({
          _tag: "conflict",
          files: ["shared.txt"],
        });
        write(b.cwd, "shared.txt", "from a and b\n");
        const outcome = yield* b.runner.continueAfterResolution;
        expect(outcome._tag).toBe("landed");
        expect(drive.mainFile("shared.txt")).toBe("from a and b");
        expect(status(b.cwd)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("abandoning a merge saves the thread's branch and leaves main alone", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const a = yield* machine(drive, root, "vm-a", "ta");
        yield* a.runner.prepare("remote-token");
        write(a.cwd, "shared.txt", "base\n");
        yield* a.runner.finishTurn({ message: "base" });
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare("remote-token");
        yield* b.runner.prepare("remote-token");
        write(a.cwd, "shared.txt", "from a\n");
        write(b.cwd, "shared.txt", "from b\n");
        yield* a.runner.finishTurn({ message: "a" });
        const main = drive.refs("ta").main;
        expect((yield* b.runner.finishTurn({ message: "b" })).outcome._tag).toBe("conflict");
        expect((yield* b.runner.abandonMerge)._tag).toBe("not_landed");
        expect(read(b.cwd, "shared.txt")).toBe("from b\n");
        expect(drive.refs("tb")).toMatchObject({ main, thread: git(b.cwd, "rev-parse", "HEAD") });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("merges again when main moves between the merge and the reconcile", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const a = yield* machine(drive, root, "vm-a", "ta");
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare("remote-token");
        yield* b.runner.prepare("remote-token");
        write(a.cwd, "a.txt", "from a\n");
        write(b.cwd, "b.txt", "from b\n");
        // Thread a lands while thread b is between its merge and its reconcile.
        drive.onceBeforeReconcile(
          a.runner.finishTurn({ message: "a" }).pipe(
            Effect.flatMap(({ outcome }) =>
              outcome._tag === "landed" ? Effect.void : Effect.die(new Error(outcome._tag)),
            ),
            Effect.orDie,
          ),
        );
        const turn = yield* b.runner.finishTurn({ message: "b" });
        expect(turn.outcome._tag).toBe("landed");
        expect(drive.calls.reconcileConflicts).toBe(1);
        expect(drive.mainFile("a.txt")).toBe("from a");
        expect(drive.mainFile("b.txt")).toBe("from b");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  /** A GitHub stand-in: a repository with history on `main`, served over `file://`. */
  const makeUpstream = (root: string) => {
    const dir = NodePath.join(root, "upstream");
    NodeFS.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    // GitHub serves partial clones, and the files a partial clone fetches later.
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

  it.effect("doesn't save a branch to publish on a drive with no remote", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
        yield* runner.prepare("remote-token");
        write(cwd, "a.txt", "a\n");
        expect((yield* runner.saveBranch("Publish"))._tag).toBe("not_saved");
        expect(drive.refs("t1").thread).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  describe("backed by a remote", () => {
    it.effect("starts a new thread from the remote's head and keeps its history there", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
          yield* runner.prepare("remote-token");

          const head = git(upstream.dir, "rev-parse", "HEAD");
          expect(drive.refs("t1")).toMatchObject({ main: head, thread: head, base: head });
          expect(read(cwd, "src/app.ts")).toBe("export {}\n");
          expect(status(cwd)).toEqual([]);
          // One commit deep: the parents stay on the remote, and git knows not to look.
          expect(drive.shallow()).toEqual([head]);
          expect(git(drive.store, "rev-list", "--count", head)).toBe("1");
          // Its folders, never its files: the remote keeps those for the drive.
          const files = git(upstream.dir, "ls-tree", "-r", "--format=%(objectname)", head).split(
            "\n",
          );
          expect(drive.promised().toSorted()).toEqual(files.toSorted());
          // git reaches the remote's files with the turn's token, which stays out of the workspace.
          const credentials = NodePath.join(root, "vm-1", "threads", ".t1.remote-credential");
          expect(read(NodePath.dirname(credentials), NodePath.basename(credentials))).toBe(
            "username=signalbox\npassword=remote-token\n",
          );
          expect(read(cwd, ".git/config")).not.toContain("remote-token");
          expect(git(cwd, "config", "--get", "extensions.partialClone")).toBe("origin");
          expect(gitOk(drive.store, "cat-file", "-e", files[0]!)).toBe(false);
          expect(git(cwd, "log", "--format=%s")).toBe("second");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("saves a turn on the thread's branch without touching main", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
          yield* runner.prepare("remote-token");
          const head = drive.refs("t1").main;
          write(cwd, "src/app.ts", "export const app = 1;\n");
          yield* runner.autosave;
          yield* runner.flush;
          const autosave = drive.refs("t1").wip;

          const turn = yield* runner.finishTurn({ message: "Add app" });
          expect(turn.outcome._tag).toBe("saved");
          expect(drive.calls.reconcile).toBe(0);
          const refs = drive.refs("t1");
          expect(refs.main).toBe(head);
          expect(refs.thread).toBe(git(cwd, "rev-parse", "HEAD"));
          expect(git(cwd, "rev-parse", "HEAD^")).toBe(head);
          // The auto-save is a side commit, never on the branch that gets pushed.
          expect(gitOk(drive.store, "merge-base", "--is-ancestor", autosave!, refs.thread!)).toBe(
            false,
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("saves unsaved work on the thread's branch mid-turn, for the agent to publish", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
          yield* runner.prepare("remote-token");
          const head = drive.refs("t1").main;
          // Edited a moment ago: no auto-save has run yet.
          write(cwd, "src/app.ts", "export const app = 1;\n");
          write(cwd, "notes.md", "new\n");

          const saved = yield* runner.saveBranch("Add app");
          expect(saved._tag).toBe("saved");
          const refs = drive.refs("t1");
          expect(refs.main).toBe(head);
          expect(refs.thread).toBe(git(cwd, "rev-parse", "HEAD"));
          expect(git(cwd, "log", "-1", "--format=%s")).toBe("Add app");
          expect(git(drive.store, "show", `${refs.thread}:notes.md`)).toBe("new");
          expect(status(cwd)).toEqual([]);

          // Nothing new: the branch stays where it is.
          expect(yield* runner.saveBranch("Again")).toEqual({ _tag: "saved", head: refs.thread });
          // The turn's end still saves, with the publish inside its checkpoint.
          write(cwd, "later.md", "later\n");
          const turn = yield* runner.finishTurn({ message: "More" });
          expect(turn.checkpoint?.start).toBe(head);
          expect(turn.checkpoint?.files.map((file) => file.path).toSorted()).toEqual([
            "later.md",
            "notes.md",
            "src/app.ts",
          ]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("moves main to a merged pull request for new threads only", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const old = yield* machine(drive, root, "vm-1", "t-old");
          yield* old.runner.prepare("remote-token");
          const before = drive.refs("t-old").main;

          const merged = upstream.commit("src/app.ts", "export const merged = true;\n", "Merge #1");
          const fresh = yield* machine(drive, root, "vm-2", "t-new");
          yield* fresh.runner.prepare("remote-token");
          expect(drive.refs("t-new")).toMatchObject({ main: merged, thread: merged, base: merged });
          expect(read(fresh.cwd, "src/app.ts")).toBe("export const merged = true;\n");

          // The older thread keeps its base; the next turn there sees the new main but stays put.
          yield* old.runner.prepare("remote-token");
          expect(drive.refs("t-old")).toMatchObject({ main: merged, thread: before, base: before });
          expect(git(old.cwd, "rev-parse", "HEAD")).toBe(before);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("restores a thread on a new machine, fetching the files the remote keeps", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const first = yield* machine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          write(first.cwd, "notes.md", "turn one\n");
          yield* first.runner.finishTurn({ message: "Notes" });
          // The remote moves on, so the thread's base is no longer what a fetch brings.
          upstream.commit("src/app.ts", "export const later = 1;\n", "Later");

          const second = yield* machine(drive, root, "vm-2", "t1");
          yield* second.runner.prepare("remote-token");
          expect(git(second.cwd, "rev-parse", "HEAD")).toBe(drive.refs("t1").thread);
          expect(read(second.cwd, "notes.md")).toBe("turn one\n");
          // The base's own files, fetched from the remote on checkout.
          expect(read(second.cwd, "src/app.ts")).toBe("export {}\n");
          expect(read(second.cwd, "README.md")).toBe("hello\n");
          expect(status(second.cwd)).toEqual([]);
          write(second.cwd, "notes.md", "turn two\n");
          expect((yield* second.runner.finishTurn({ message: "More" })).outcome._tag).toBe("saved");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("can't restore a thread on a new machine while the remote is unreachable", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const first = yield* machine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          write(first.cwd, "notes.md", "turn one\n");
          yield* first.runner.finishTurn({ message: "Notes" });

          // The drive keeps the remote's files on the remote: without it, nothing to check out.
          NodeFS.rmSync(upstream.dir, { recursive: true, force: true });
          const second = yield* machine(drive, root, "vm-2", "t1");
          const failed = yield* second.runner.prepare("remote-token").pipe(Effect.flip);
          expect(failed.message).toMatch(/owner\/repo/);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("starts from the drive's copy when main can't follow the remote yet", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const first = yield* machine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          const before = drive.refs("t1").main;

          upstream.commit("src/app.ts", "export const later = true;\n", "Later");
          drive.settings.refuseMirror = true;
          const second = yield* machine(drive, root, "vm-2", "t2");
          yield* second.runner.prepare("remote-token");
          expect(drive.refs("t2")).toMatchObject({ main: before, thread: before });
          expect(read(second.cwd, "src/app.ts")).toBe("export {}\n");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("fails a thread's first turn with why its first save was rejected, in one line", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const client = drive.client("t1");
          const runner = yield* makeRunnerDrive({
            cwd: NodePath.join(root, "vm-1", "threads", "t1"),
            client: {
              ...client,
              uploadPack: () =>
                Effect.fail(
                  new DriveClientError({
                    message: "A pack of 110795399 bytes is bigger than the drive takes (67108864).",
                    retryable: false,
                  }),
                ),
            },
          });
          const failed = yield* runner.prepare("remote-token").pipe(Effect.flip);
          expect(failed.message).toBe(
            "Saving owner/repo's latest version failed: A pack of 110795399 bytes is bigger than the drive takes (67108864).",
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("fails a thread's first turn when the remote can't be fetched", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          NodeFS.rmSync(upstream.dir, { recursive: true, force: true });
          const { runner } = yield* machine(drive, root, "vm-1", "t1");
          const failed = yield* runner.prepare("remote-token").pipe(Effect.flip);
          expect(failed.message).toMatch(/Fetching owner\/repo failed/);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );
  });
});
