// @effect-diagnostics nodeBuiltinImport:off - the fake drive and the assertions run real git on temp dirs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DriveState, RefWriteResult } from "@signalbox/runner-protocol/DriveProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeRunnerDrive } from "./RunnerDrive.ts";
import type { DriveClient } from "./RunnerDriveClient.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
};

const gitRaw = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const git = (cwd: string, ...args: Array<string>) => gitRaw(cwd, ...args).trim();
const status = (cwd: string) => gitRaw(cwd, "status", "--porcelain").split("\n").filter(Boolean);

const gitOk = (cwd: string, ...args: Array<string>) => {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};

const write = (cwd: string, file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, file), text);
};
const read = (cwd: string, file: string) => NodeFS.readFileSync(NodePath.join(cwd, file), "utf8");

/**
 * A drive the way the cloud keeps one: packs in a bare repository that holds
 * nothing else (so its connectivity is exactly the packs'), refs in memory.
 * Uploads must be closed and not thin; refs move by CAS to commits it has;
 * `main` only fast-forwards to the thread's branch, from the main it merged.
 */
const makeFakeDrive = (root: string) => {
  const store = NodePath.join(root, "store");
  NodeFS.mkdirSync(store, { recursive: true });
  git(store, "init", "-q", "--bare");
  const packDir = NodePath.join(store, "objects", "pack");
  const packs: Array<{ seq: number; name: string; size: number }> = [];
  let main: string | null = null;
  const threads = new Map<
    string,
    { thread: string | null; wip: string | null; base: string | null }
  >();
  const calls = { reconcile: 0, reconcileConflicts: 0 };
  let beforeReconcile: Effect.Effect<void> | null = null;

  /** Like the cloud, lists only packs after the ones the machine says it has. */
  const state = (threadId: string, packsAfter: number): DriveState => {
    const refs = threads.get(threadId)!;
    return {
      driveId: "drive-1",
      main,
      ...refs,
      packs: packs.filter((pack) => pack.seq > packsAfter),
    };
  };
  const has = (oid: string) => gitOk(store, "cat-file", "-e", `${oid}^{commit}`);

  const client = (threadId: string): DriveClient => {
    let packsAfter = 0;
    return {
      havePacksThrough: (seq) => {
        packsAfter = Math.max(packsAfter, seq);
      },
      open: Effect.sync(() => {
        if (!threads.has(threadId)) threads.set(threadId, { thread: main, wip: null, base: main });
        return state(threadId, packsAfter);
      }),
      downloadPack: (name, dir) =>
        Effect.sync(() => {
          NodeFS.mkdirSync(dir, { recursive: true });
          for (const ext of ["pack", "idx"]) {
            const target = NodePath.join(dir, `pack-${name}.${ext}`);
            if (!NodeFS.existsSync(target)) {
              NodeFS.copyFileSync(NodePath.join(packDir, `pack-${name}.${ext}`), target);
            }
          }
        }),
      uploadPack: (idx, pack) =>
        Effect.sync(() => {
          const name = Buffer.from(pack.subarray(pack.length - 20)).toString("hex");
          NodeFS.writeFileSync(NodePath.join(packDir, `pack-${name}.pack`), pack);
          NodeFS.writeFileSync(NodePath.join(packDir, `pack-${name}.idx`), idx);
          // Not thin: every delta base is inside the pack.
          const listing = git(
            store,
            "verify-pack",
            "-v",
            NodePath.join(packDir, `pack-${name}.idx`),
          );
          // Closed: everything its commits reach is in this pack or an earlier one.
          const commits = listing
            .split("\n")
            .filter((line) => / commit /.test(line))
            .map((line) => line.split(" ")[0]!);
          for (const commit of commits) git(store, "rev-list", "--objects", commit);
          packs.push({ seq: packs.length + 1, name, size: pack.length });
          return {
            name,
            objects: listing.split("\n").filter((line) => /^[0-9a-f]{40} /.test(line)).length,
          };
        }),
      updateRefs: (updates) =>
        Effect.sync((): RefWriteResult => {
          const refs = threads.get(threadId)!;
          if (updates.some((update) => refs[update.ref] !== update.old)) {
            return { _tag: "conflict", state: state(threadId, packsAfter) };
          }
          if (!updates.every((update) => has(update.new))) {
            return { _tag: "refused", reason: "unknown commit" };
          }
          for (const update of updates) refs[update.ref] = update.new;
          return { _tag: "ok", state: state(threadId, packsAfter) };
        }),
      reconcile: (request) =>
        Effect.gen(function* () {
          calls.reconcile++;
          const hook = beforeReconcile;
          beforeReconcile = null;
          if (hook !== null) yield* hook;
          const refs = threads.get(threadId)!;
          if (main !== request.expectedMain) {
            calls.reconcileConflicts++;
            return { _tag: "conflict", state: state(threadId, packsAfter) } as RefWriteResult;
          }
          if (refs.thread !== request.newMain) {
            return { _tag: "refused", reason: "not the thread's branch" } as RefWriteResult;
          }
          if (
            main !== null &&
            !gitOk(store, "merge-base", "--is-ancestor", main, request.newMain)
          ) {
            return { _tag: "refused", reason: "not a fast-forward" } as RefWriteResult;
          }
          main = request.newMain;
          return { _tag: "ok", state: state(threadId, packsAfter) } as RefWriteResult;
        }),
    };
  };

  return {
    store,
    packDir,
    packs,
    calls,
    client,
    refs: (threadId: string) => ({ main, ...threads.get(threadId)! }),
    mainFile: (file: string) => git(store, "show", `${main}:${file}`),
    onceBeforeReconcile: (effect: Effect.Effect<void>) => {
      beforeReconcile = effect;
    },
  };
};

const makeRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-drive-"));

const machine = (
  drive: ReturnType<typeof makeFakeDrive>,
  root: string,
  name: string,
  threadId: string,
) =>
  makeRunnerDrive({
    cwd: NodePath.join(root, name, "threads", threadId),
    client: drive.client(threadId),
  }).pipe(
    Effect.map((runner) => ({ runner, cwd: NodePath.join(root, name, "threads", threadId) })),
  );

const scopedTest = <A, E>(body: (root: string) => Effect.Effect<A, E, never>) =>
  Effect.suspend(() => {
    const root = makeRoot();
    return body(root).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  });

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
          yield* runner.prepare;
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

  it.effect("restores the thread's branch and its auto-save on a brand new machine", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* machine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare;
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
        yield* second.runner.prepare;
        expect(git(second.cwd, "rev-parse", "HEAD")).toBe(drive.refs("t1").thread);
        expect(git(second.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/signalbox");
        expect(read(second.cwd, "a.txt")).toBe("one\ntwo\n");
        expect(read(second.cwd, "b.txt")).toBe("new\n");
        expect(status(second.cwd)).toEqual([" M a.txt", "?? b.txt"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("never saves dependency trees, and checking out leaves them in place", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* machine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare;
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
        yield* first.runner.prepare;
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
        yield* a.runner.prepare;
        yield* b.runner.prepare;
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
        yield* a.runner.prepare;
        write(a.cwd, "shared.txt", "base\n");
        yield* a.runner.finishTurn({ message: "base" });
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare;
        yield* b.runner.prepare;
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
        yield* a.runner.prepare;
        write(a.cwd, "shared.txt", "base\n");
        yield* a.runner.finishTurn({ message: "base" });
        const b = yield* machine(drive, root, "vm-b", "tb");
        yield* a.runner.prepare;
        yield* b.runner.prepare;
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
        yield* a.runner.prepare;
        yield* b.runner.prepare;
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
});
