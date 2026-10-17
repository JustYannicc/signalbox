// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - the assertions run real git on temp dirs, and fake secrets are generated per run.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DRIVE_COMMIT_AUTHOR,
  type CheckpointViews,
  threadRemoteBranch,
} from "@signalbox/runner-protocol/DriveProtocol";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
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
import { makeSecretMask } from "./secretMask.ts";

/** A folder secret's value, new each run. */
const fakeSecret = () => `sk-fake-${crypto.randomUUID()}`;

describe("RunnerDrive", () => {
  it.effect("does not capture a checkpoint before preparing the drive", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const { runner } = yield* machine(drive, root, "vm-1", "t1");
        expect(yield* runner.captureCheckpoint).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

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

  it.effect("restores an empty start on reused and fresh machines without taking in main", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* machine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare("remote-token");
        write(first.cwd, "removed.txt", "discard this turn\n");
        const saved = yield* first.runner.finishTurn();
        const main = drive.refs("t1").main;
        expect(saved.checkpoint?.start).toBeNull();
        drive.pinToCheckpoint("t1", null, { shortcuts: [], context: null });

        for (const current of [first, yield* machine(drive, root, "vm-2", "t1")]) {
          yield* current.runner.prepare("remote-token");
          expect(NodeFS.existsSync(NodePath.join(current.cwd, "removed.txt"))).toBe(false);
          expect(gitOk(current.cwd, "rev-parse", "--verify", "HEAD")).toBe(false);
          expect(status(current.cwd)).toEqual([]);
        }
        expect(drive.refs("t1").main).toBe(main);
        write(first.cwd, "next.txt", "after undo\n");
        const next = yield* first.runner.finishTurn();
        expect(next.checkpoint?.start).toBeNull();
        expect(next.checkpoint?.files.map((file) => file.path)).toEqual(["next.txt"]);
        expect(next.outcome._tag).toBe("saved");
        expect(drive.refs("t1").main).toBe(main);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("creates a revision for an empty first turn", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const { runner } = yield* machine(drive, root, "vm-1", "t1");
        yield* runner.prepare("remote-token");
        const turn = yield* runner.finishTurn();
        expect(turn.checkpoint?.files).toEqual([]);
        expect(turn.checkpoint?.commit).not.toBeNull();
        expect(turn.outcome._tag).toBe("landed");
        expect(drive.refs("t1")).toMatchObject({
          main: turn.checkpoint?.commit,
          thread: turn.checkpoint?.commit,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect(
    "keeps every run and exact read pins in a durable notes ref, including unchanged turns",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const first = yield* machine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          const firstTurn = yield* first.runner.finishTurn();
          const firstCheckpoint = firstTurn.checkpoint!;
          const views: CheckpointViews = {
            shortcuts: [{ path: "spec", target: "drive-spec", commit: "a".repeat(40) }],
            context: {
              driveId: "drive-home",
              contexts: [
                {
                  contextId: "private-context",
                  name: "Personal",
                  drives: [
                    {
                      driveId: "drive-personal",
                      path: "My Drive",
                      commit: "b".repeat(40),
                      time: 123,
                      shortcuts: [],
                    },
                  ],
                },
              ],
            },
          };
          yield* first.runner.recordCheckpoint({
            threadId: "t1",
            runId: "run-1",
            turnId: "provider-turn-1",
            commit: firstCheckpoint.commit,
            start: firstCheckpoint.start,
            views,
          });

          yield* first.runner.prepare("remote-token");
          const secondTurn = yield* first.runner.finishTurn();
          expect(secondTurn.checkpoint?.commit).toBe(firstCheckpoint.commit);
          expect(secondTurn.checkpoint?.files).toEqual([]);
          yield* first.runner.recordCheckpoint({
            threadId: "t1",
            runId: "run-2",
            turnId: "provider-turn-2",
            commit: secondTurn.checkpoint!.commit,
            start: secondTurn.checkpoint!.start,
            views,
          });

          const note = git(first.cwd, "notes", "show", firstCheckpoint.commit);
          const records = note
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(records).toEqual([
            expect.objectContaining({
              threadId: "t1",
              turnId: "provider-turn-1",
              runId: "run-1",
              commit: firstCheckpoint.commit,
              views: {
                shortcuts: [{ path: "spec", target: "drive-spec", commit: "a".repeat(40) }],
                context: [{ driveId: "drive-personal", commit: "b".repeat(40) }],
              },
            }),
            expect.objectContaining({
              threadId: "t1",
              turnId: "provider-turn-2",
              runId: "run-2",
              commit: firstCheckpoint.commit,
            }),
          ]);
          expect(note).not.toContain("Personal");
          expect(note).not.toContain("My Drive");
          expect(drive.checkpoints("t1").at(-1)?.views).toEqual(views);

          const restored = yield* machine(drive, root, "vm-2", "t1");
          yield* restored.runner.prepare("remote-token");
          expect(git(restored.cwd, "notes", "show", firstCheckpoint.commit)).toBe(note);
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
        const turn = yield* first.runner.finishTurn();
        expect(turn.outcome._tag).toBe("landed");
        expect(turn.checkpoint?.files).toEqual([
          { path: "a.txt", kind: "added", additions: 1, deletions: 0 },
        ]);
        expect(git(first.cwd, "log", "-1", "--format=%s")).toBe("Add a.txt");
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
        yield* runner.finishTurn();
        expect(ident("HEAD")).toBe(`${octo}|${octo}`);

        // A cloud that sends no author, or an owner who disconnected GitHub.
        yield* runner.prepare("remote-token");
        write(cwd, "b.txt", "two\n");
        yield* runner.finishTurn();
        const signalbox = `${DRIVE_COMMIT_AUTHOR.name} <${DRIVE_COMMIT_AUTHOR.email}>`;
        expect(ident("HEAD")).toBe(`${signalbox}|${signalbox}`);
        expect(ident("HEAD^")).toBe(`${octo}|${octo}`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("titles a turn's commit with what changed, and lists the files", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
        yield* runner.prepare("remote-token");
        write(cwd, "src/a.ts", "a\n");
        write(cwd, "notes.md", "n\n");
        yield* runner.finishTurn();
        expect(git(cwd, "log", "-1", "--format=%B")).toBe(
          "Add notes.md and a.ts\n\nA\tnotes.md\nA\tsrc/a.ts",
        );

        yield* runner.prepare("remote-token");
        git(cwd, "mv", "notes.md", "README.md");
        yield* runner.finishTurn();
        expect(git(cwd, "log", "-1", "--format=%s")).toBe("Rename notes.md to README.md");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("masks a folder's secret in a file name the commit lists", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const secret = fakeSecret();
        const secretMask = makeSecretMask();
        secretMask.add([{ name: "API_KEY", value: secret }]);
        const drive = makeFakeDrive(root);
        const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1", { secretMask });
        yield* runner.prepare("remote-token");
        // Long enough that the title is cut inside the secret's value.
        write(cwd, `keys/${"k".repeat(50)}${secret}.txt`, "x\n");
        yield* runner.finishTurn();
        const message = git(cwd, "log", "-1", "--format=%B");
        expect(message).not.toContain(secret.slice(0, 12));
        expect(message).toContain(`A\tkeys/${"k".repeat(50)}{{secret:API_KEY}}.txt`);
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
        const turn = yield* first.runner.finishTurn();
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
        expect((yield* a.runner.finishTurn()).outcome._tag).toBe("landed");
        const landed = yield* b.runner.finishTurn();
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
        yield* a.runner.finishTurn();
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare("remote-token");
        yield* b.runner.prepare("remote-token");
        write(a.cwd, "shared.txt", "from a\n");
        write(b.cwd, "shared.txt", "from b\n");
        expect((yield* a.runner.finishTurn()).outcome._tag).toBe("landed");
        const turn = yield* b.runner.finishTurn();
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
        yield* a.runner.finishTurn();
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare("remote-token");
        yield* b.runner.prepare("remote-token");
        write(a.cwd, "shared.txt", "from a\n");
        write(b.cwd, "shared.txt", "from b\n");
        yield* a.runner.finishTurn();
        const main = drive.refs("ta").main;
        expect((yield* b.runner.finishTurn()).outcome._tag).toBe("conflict");
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
          a.runner.finishTurn().pipe(
            Effect.flatMap(({ outcome }) =>
              outcome._tag === "landed" ? Effect.void : Effect.die(new Error(outcome._tag)),
            ),
            Effect.orDie,
          ),
        );
        const turn = yield* b.runner.finishTurn();
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
          // The drive keeps it one commit deep; the thread has the remote's whole history (#394).
          expect(drive.shallow()).toEqual([head]);
          expect(git(drive.store, "rev-list", "--count", head)).toBe("1");
          expect(git(cwd, "log", "--format=%s")).toBe("second\nfirst");
          expect(git(cwd, "rev-parse", "--is-shallow-repository")).toBe("false");
          expect(git(cwd, "rev-parse", "refs/remotes/origin/main")).toBe(head);
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

          const turn = yield* runner.finishTurn();
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
          expect(yield* runner.saveBranch("Again")).toEqual({
            _tag: "saved",
            head: refs.thread,
            lease: null,
          });
          // The turn's end still saves, with the publish inside its checkpoint.
          write(cwd, "later.md", "later\n");
          const turn = yield* runner.finishTurn();
          expect(turn.checkpoint?.start).toBe(head);
          expect(turn.checkpoint?.files.map((file) => file.path).toSorted()).toEqual([
            "later.md",
            "notes.md",
            "src/app.ts",
          ]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("describes the change when the agent publishes without a commit message", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
          yield* runner.prepare("remote-token");
          write(cwd, "src/app.ts", "export const app = 1;\n");

          expect((yield* runner.saveBranch())._tag).toBe("saved");
          expect(git(cwd, "log", "-1", "--format=%B")).toBe("Update app.ts\n\nM\tsrc/app.ts");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    );

    it.effect("masks a folder's secret in the agent's commit message", () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const secret = fakeSecret();
          const secretMask = makeSecretMask();
          secretMask.add([{ name: "API_KEY", value: secret }]);
          const upstream = makeUpstream(root);
          const drive = makeFakeDrive(root, { upstream: upstream.dir });
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1", { secretMask });
          yield* runner.prepare("remote-token");
          write(cwd, "src/app.ts", "export const app = 1;\n");

          expect((yield* runner.saveBranch(`Use key ${secret}\n\nIt is ${secret}.`))._tag).toBe(
            "saved",
          );
          expect(git(cwd, "log", "-1", "--format=%B")).toBe(
            "Use key {{secret:API_KEY}}\n\nIt is {{secret:API_KEY}}.",
          );
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
          yield* first.runner.finishTurn();
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
          expect((yield* second.runner.finishTurn()).outcome._tag).toBe("saved");
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
          yield* first.runner.finishTurn();

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

    describe("with the remote's history", () => {
      const agent = (cwd: string, ...args: Array<string>) =>
        git(cwd, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", ...args);

      it.effect("rebases onto a newer main and saves the branch, closed, for any machine", () =>
        scopedTest((root) =>
          Effect.gen(function* () {
            const upstream = makeUpstream(root);
            const first = git(upstream.dir, "rev-parse", "HEAD~1");
            const drive = makeFakeDrive(root, { upstream: upstream.dir });
            const vm1 = yield* machine(drive, root, "vm-1", "t1");
            yield* vm1.runner.prepare("remote-token");
            write(vm1.cwd, "notes.md", "mine\n");
            expect((yield* vm1.runner.finishTurn()).outcome._tag).toBe("saved");

            // The next turn starts; then, mid-turn, main moves on: a pull request branched
            // before the drive's main merges in. The drive's main stays where it was.
            yield* vm1.runner.prepare("remote-token");
            git(upstream.dir, "switch", "-q", "-c", "feature", first);
            upstream.commit("feature.ts", "export const f = 1;\n", "Feature");
            git(upstream.dir, "switch", "-q", "main");
            git(
              upstream.dir,
              "-c",
              "user.name=Dev",
              "-c",
              "user.email=dev@example.com",
              "merge",
              "-q",
              "--no-ff",
              "feature",
              "-m",
              "Merge feature",
            );
            const main = upstream.commit("src/app.ts", "export const later = 1;\n", "Later");

            agent(vm1.cwd, "fetch", "-q", "origin");
            agent(vm1.cwd, "rebase", "-q", "origin/main");
            expect(git(vm1.cwd, "rev-parse", "HEAD~1")).toBe(main);
            expect((yield* vm1.runner.finishTurn()).outcome._tag).toBe("saved");
            const head = git(vm1.cwd, "rev-parse", "HEAD");
            expect(drive.refs("t1").thread).toBe(head);
            // The main it rebased onto rides along one commit deep; its history stays on the remote.
            expect(drive.refs("t1").main).not.toBe(main);
            expect(drive.shallow()).toContain(main);
            // Its files too: only the thread's own file travelled.
            expect(gitOk(drive.store, "cat-file", "-e", `${main}:feature.ts`)).toBe(false);
            expect(git(drive.store, "show", `${head}:notes.md`)).toBe("mine");

            const vm2 = yield* machine(drive, root, "vm-2", "t1");
            yield* vm2.runner.prepare("remote-token");
            expect(git(vm2.cwd, "rev-parse", "HEAD")).toBe(head);
            expect(read(vm2.cwd, "feature.ts")).toBe("export const f = 1;\n");
            expect(read(vm2.cwd, "notes.md")).toBe("mine\n");
            expect(git(vm2.cwd, "log", "--format=%s")).toContain("Merge feature");
            expect(NodeFS.existsSync(NodePath.join(vm2.cwd, ".git", "shallow"))).toBe(false);
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        ),
      );

      it.effect("leaves a rebase conflict to the agent and saves what it resolved", () =>
        scopedTest((root) =>
          Effect.gen(function* () {
            const upstream = makeUpstream(root);
            const drive = makeFakeDrive(root, { upstream: upstream.dir });
            const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
            yield* runner.prepare("remote-token");
            write(cwd, "README.md", "mine\n");
            yield* runner.finishTurn();
            upstream.commit("README.md", "theirs\n", "Theirs");

            yield* runner.prepare("remote-token");
            agent(cwd, "fetch", "-q", "origin");
            expect(
              gitOk(cwd, "-c", "user.name=A", "-c", "user.email=a@b.c", "rebase", "origin/main"),
            ).toBe(false);
            // Mid-rebase the worktree holds conflict markers: nothing of it is saved.
            const wip = drive.refs("t1").wip;
            yield* runner.autosave;
            yield* runner.flush;
            expect(drive.refs("t1").wip).toBe(wip);

            write(cwd, "README.md", "both\n");
            agent(cwd, "add", "README.md");
            git(
              cwd,
              "-c",
              "core.editor=true",
              "-c",
              "user.name=A",
              "-c",
              "user.email=a@b.c",
              "rebase",
              "--continue",
            );
            expect((yield* runner.finishTurn()).outcome._tag).toBe("saved");
            expect(git(drive.store, "show", `${drive.refs("t1").thread}:README.md`)).toBe("both");
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        ),
      );

      it.effect("pulls commits pushed to the thread's branch from elsewhere, and leases them", () =>
        scopedTest((root) =>
          Effect.gen(function* () {
            const upstream = makeUpstream(root);
            const drive = makeFakeDrive(root, { upstream: upstream.dir });
            const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
            yield* runner.prepare("remote-token");
            write(cwd, "notes.md", "mine\n");
            yield* runner.finishTurn();
            const mine = git(cwd, "rev-parse", "HEAD");

            // Pushed as the thread's branch, then someone else adds to it on GitHub.
            const branch = threadRemoteBranch("t1");
            git(upstream.dir, "fetch", "-q", cwd, `refs/heads/signalbox:refs/heads/${branch}`);
            const tree = git(upstream.dir, "rev-parse", `${mine}^{tree}`);
            const theirs = git(
              upstream.dir,
              "-c",
              "user.name=Dev",
              "-c",
              "user.email=dev@example.com",
              "commit-tree",
              tree,
              "-p",
              mine,
              "-m",
              "From elsewhere",
            );
            git(upstream.dir, "update-ref", `refs/heads/${branch}`, theirs);

            yield* runner.prepare("remote-token");
            // Not taken in yet: publishing may not replace it.
            expect(yield* runner.saveBranch("Publish")).toEqual({
              _tag: "saved",
              head: mine,
              lease: null,
            });
            agent(cwd, "pull", "-q", "--rebase");
            expect(git(cwd, "rev-parse", "HEAD")).toBe(theirs);
            write(cwd, "more.md", "more\n");
            const saved = yield* runner.saveBranch("More");
            expect(saved).toMatchObject({ _tag: "saved", lease: theirs });
            expect(git(drive.store, "rev-parse", `${drive.refs("t1").thread}^`)).toBe(theirs);
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        ),
      );

      describe("after the thread's pull request merged (#495)", () => {
        /** The thread's pull request #7 from its own branch, as GitHub last said. */
        const pullRequest = (threadId: string, state: "open" | "merged") =>
          ({
            host: "github.com",
            repository: "owner/repo",
            number: 7,
            url: "https://github.com/owner/repo/pull/7",
            source: "created",
            linkedAt: "2026-10-16T10:00:00.000Z",
            snapshot: {
              state,
              title: "Feature",
              headBranch: threadRemoteBranch(threadId),
              baseBranch: "main",
              isDraft: false,
              updatedAt: null,
              syncedAt: "2026-10-16T10:00:00.000Z",
            },
            stack: null,
          }) as ThreadPullRequestLink;
        const prepareWith = (
          runner: Effect.Success<ReturnType<typeof machine>>["runner"],
          state: "open" | "merged",
          threadId = "t1",
        ) => runner.prepare("remote-token", undefined, [], [pullRequest(threadId, state)]);

        it.effect(
          "keeps a restored checkpoint pinned while main advances and its PR is merged",
          () =>
            scopedTest((root) =>
              Effect.gen(function* () {
                const upstream = makeUpstream(root);
                const drive = makeFakeDrive(root, { upstream: upstream.dir });
                const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
                yield* runner.prepare("remote-token");
                write(cwd, "feature.ts", "export const f = 1;\n");
                const firstTurn = yield* runner.finishTurn();
                const selected = firstTurn.checkpoint!.commit;

                upstream.commit("feature.ts", "export const f = 1;\n", "Feature (#7)");
                upstream.commit("main-only.ts", "export const m = 1;\n", "Other main work");
                const latestMain = git(upstream.dir, "rev-parse", "HEAD");
                drive.pinToCheckpoint("t1", selected, { shortcuts: [], context: null });

                const prepared = yield* prepareWith(runner, "merged");
                expect(prepared.notices).toEqual([]);
                expect(git(cwd, "rev-parse", "HEAD")).toBe(selected);
                expect(NodeFS.existsSync(NodePath.join(cwd, "main-only.ts"))).toBe(false);

                write(cwd, "followup.ts", "export const next = 1;\n");
                const followup = yield* runner.finishTurn();
                expect(followup.outcome._tag).toBe("saved");
                expect(followup.checkpoint?.start).toBe(selected);
                expect(git(cwd, "rev-parse", "HEAD^1")).toBe(selected);
                expect(NodeFS.existsSync(NodePath.join(cwd, "main-only.ts"))).toBe(false);
                expect(drive.refs("t1").main).toBe(latestMain);
                expect(drive.refs("t1").thread).toBe(followup.checkpoint?.commit);
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
            ),
        );

        it.effect(
          "takes in main before the next turn, so the next pull request carries only new work",
          () =>
            scopedTest((root) =>
              Effect.gen(function* () {
                const upstream = makeUpstream(root);
                const drive = makeFakeDrive(root, { upstream: upstream.dir });
                const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
                yield* runner.prepare("remote-token");
                write(cwd, "feature.ts", "export const f = 1;\n");
                yield* runner.finishTurn();
                const published = git(cwd, "rev-parse", "HEAD");

                // While its pull request is open, the branch stays as the agent left it.
                upstream.commit("other.ts", "export const o = 1;\n", "Other");
                expect((yield* prepareWith(runner, "open")).notices).toEqual([]);
                expect(git(cwd, "rev-parse", "HEAD")).toBe(published);

                // GitHub squash-merges it: main gets the same change as one new commit.
                const main = upstream.commit("feature.ts", "export const f = 1;\n", "Feature (#7)");
                const prepared = yield* prepareWith(runner, "merged");
                expect(prepared.notices).toEqual([
                  "Pull request #7 merged, so this thread took in the latest main first.",
                ]);
                expect(prepared.mainConflict).toBeUndefined();
                const merged = git(cwd, "rev-parse", "HEAD");
                expect(git(cwd, "rev-parse", "HEAD^1", "HEAD^2")).toBe(`${published}\n${main}`);
                expect(git(cwd, "log", "-1", "--format=%s")).toBe("Merge main after #7 merged");
                expect(drive.refs("t1").thread).toBe(merged);
                expect(git(cwd, "diff", "--name-only", main, "HEAD")).toBe("");
                expect(status(cwd)).toEqual([]);

                write(cwd, "next.ts", "export const n = 1;\n");
                const turn = yield* runner.finishTurn();
                expect(turn.checkpoint?.start).toBe(merged);
                expect(turn.checkpoint?.files.map((file) => file.path)).toEqual(["next.ts"]);
                // What its next pull request shows, compared the way GitHub does.
                expect(git(cwd, "diff", "--name-only", `${main}...HEAD`)).toBe("next.ts");

                // Main is in: the next turn start merges nothing more.
                const head = git(cwd, "rev-parse", "HEAD");
                expect((yield* prepareWith(runner, "merged")).notices).toEqual([]);
                expect(git(cwd, "rev-parse", "HEAD")).toBe(head);

                // A new machine starts from the merged branch.
                const vm2 = yield* machine(drive, root, "vm-2", "t1");
                yield* prepareWith(vm2.runner, "merged");
                expect(git(vm2.cwd, "rev-parse", "HEAD")).toBe(head);
                expect(read(vm2.cwd, "other.ts")).toBe("export const o = 1;\n");
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
            ),
        );

        it.effect("commits work a stopped turn left before taking main in", () =>
          scopedTest((root) =>
            Effect.gen(function* () {
              const upstream = makeUpstream(root);
              const drive = makeFakeDrive(root, { upstream: upstream.dir });
              const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1");
              yield* runner.prepare("remote-token");
              write(cwd, "feature.ts", "export const f = 1;\n");
              yield* runner.finishTurn();
              write(cwd, "draft.md", "unsaved\n");

              upstream.commit("feature.ts", "export const f = 1;\n", "Feature (#7)");
              yield* prepareWith(runner, "merged");
              expect(read(cwd, "draft.md")).toBe("unsaved\n");
              expect(status(cwd)).toEqual([]);
              expect(git(cwd, "log", "-2", "--format=%s")).toBe(
                "Merge main after #7 merged\nAdd draft.md",
              );
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
          ),
        );

        /**
         * A thread whose pull request #7 merged, after which it changed the
         * same line as someone else did on main: taking main in conflicts.
         */
        const conflicting = (root: string) =>
          Effect.gen(function* () {
            const upstream = makeUpstream(root);
            const drive = makeFakeDrive(root, { upstream: upstream.dir });
            const vm = yield* machine(drive, root, "vm-1", "t1");
            yield* vm.runner.prepare("remote-token");
            write(vm.cwd, "src/app.ts", "export const a = 1;\n");
            yield* vm.runner.finishTurn();
            write(vm.cwd, "src/app.ts", "export const a = 2;\n");
            yield* vm.runner.finishTurn();
            const before = git(vm.cwd, "rev-parse", "HEAD");
            upstream.commit("src/app.ts", "export const a = 1;\n", "Feature (#7)");
            const main = upstream.commit("src/app.ts", "export const a = 3;\n", "Theirs");
            return { drive, ...vm, before, main };
          });

        it.effect("leaves a conflict with main to the agent and saves what it resolved", () =>
          scopedTest((root) =>
            Effect.gen(function* () {
              const { drive, runner, cwd, before, main } = yield* conflicting(root);
              const prepared = yield* prepareWith(runner, "merged");
              expect(prepared.mainConflict).toEqual({
                pullRequest: 7,
                branch: "main",
                files: ["src/app.ts"],
              });
              // Nothing is left half-merged until the agent is there to resolve it.
              expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
              expect(status(cwd)).toEqual([]);
              expect(gitOk(cwd, "rev-parse", "--verify", "-q", "MERGE_HEAD")).toBe(false);

              expect(yield* runner.takeInMain).toEqual({ _tag: "conflict", files: ["src/app.ts"] });
              expect(read(cwd, "src/app.ts")).toContain("<<<<<<< ");
              expect(drive.refs("t1").thread).toBe(before);

              expect(yield* runner.continueAfterResolution).toEqual({
                _tag: "conflict",
                files: ["src/app.ts"],
              });
              write(cwd, "src/app.ts", "export const a = 2 + 3;\n");
              const outcome = yield* runner.continueAfterResolution;
              const merged = git(cwd, "rev-parse", "HEAD");
              expect(outcome).toEqual({ _tag: "saved", head: merged });
              expect(git(cwd, "rev-parse", "HEAD^1", "HEAD^2")).toBe(`${before}\n${main}`);
              expect(drive.refs("t1").thread).toBe(merged);
              expect(status(cwd)).toEqual([]);

              // The turn's own work starts after the merge.
              write(cwd, "next.ts", "export const n = 1;\n");
              const turn = yield* runner.finishTurn();
              expect(turn.checkpoint?.start).toBe(merged);
              expect(turn.checkpoint?.files.map((file) => file.path)).toEqual(["next.ts"]);
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
          ),
        );

        it.effect(
          "drops an unresolved merge with main, keeping the branch, and tries again next turn",
          () =>
            scopedTest((root) =>
              Effect.gen(function* () {
                const { drive, runner, cwd, before } = yield* conflicting(root);
                expect((yield* prepareWith(runner, "merged")).mainConflict).toBeDefined();
                expect((yield* runner.takeInMain)._tag).toBe("conflict");
                expect((yield* runner.abandonMerge)._tag).toBe("not_landed");
                expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
                expect(read(cwd, "src/app.ts")).toBe("export const a = 2;\n");
                expect(status(cwd)).toEqual([]);
                expect(drive.refs("t1").thread).toBe(before);

                expect((yield* prepareWith(runner, "merged")).mainConflict?.files).toEqual([
                  "src/app.ts",
                ]);
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
            ),
        );
      });
    });

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
