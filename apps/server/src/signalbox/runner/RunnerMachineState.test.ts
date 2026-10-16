// @effect-diagnostics nodeBuiltinImport:off - the assertions run real git on temp dirs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { threadRemoteBranch } from "@signalbox/runner-protocol/DriveProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import { type FakeDrive, git, makeFakeDrive, read, scopedTest, write } from "./driveTesting.ts";
import type { DependencyTree } from "./RunnerDependencies.ts";
import { makeRunnerDrive } from "./RunnerDrive.ts";
import { CODEX_ROLLOUT_INDEXES, outsideFolders } from "./RunnerMachineFolders.ts";
import type { OutsideFolder } from "./RunnerMachineState.ts";
import { type MachineLayout, machineLayout } from "./RunnerModelAccess.ts";

/**
 * A thread's machine: its checkout, and its home and harness folders beside
 * it, as `RunnerHost.ts` lays them out and keeps them. `trees` stands in for
 * `RunnerDependencies.ts`: the dependency trees it would rebuild.
 */
const threadMachine = (
  drive: FakeDrive,
  root: string,
  name: string,
  threadId: string,
  {
    trees = () => [],
    outside = outsideFolders,
  }: {
    readonly trees?: () => ReadonlyArray<DependencyTree>;
    readonly outside?: (layout: MachineLayout) => ReadonlyArray<OutsideFolder>;
  } = {},
) => {
  const base = NodePath.join(root, name);
  const cwd = NodePath.join(base, "workspaces", threadId, "drive");
  const machineRoot = NodePath.join(base, "machines", threadId);
  return Effect.gen(function* () {
    const layout = machineLayout(yield* Path.Path, machineRoot);
    const { home, claudeHome: claude, codexHome: codex } = layout;
    for (const dir of [home, claude, codex]) NodeFS.mkdirSync(dir, { recursive: true });
    // What the Runner itself writes at start, on every machine.
    write(claude, "settings.json", `{"apiKeyHelper":"cat ${name}"}`);
    const runner = yield* makeRunnerDrive({
      cwd,
      client: drive.client(threadId),
      branch: threadRemoteBranch(threadId),
      machine: { outside: outside(layout), trees: Effect.sync(trees) },
    });
    return { runner, cwd, home, claude, codex };
  });
};

const exists = (dir: string, file: string) => NodeFS.existsSync(NodePath.join(dir, file));

/** Every file a commit's tree holds. */
const filesOf = (store: string, commit: string) =>
  git(store, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);

const installedTree = (cwd: string, path: string, recipe: string): DependencyTree => ({
  path,
  recipe,
  installed: {
    inputs: "key-1",
    record: NodePath.join(cwd, path, ".signalbox-dependencies.json"),
  },
});

const run = <A, E>(
  body: (root: string) => Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
) => scopedTest((root) => body(root).pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

describe("RunnerMachineState", () => {
  it.effect(
    "brings gitignored files back on a new machine, and never puts them on the branch",
    () =>
      run((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const first = yield* threadMachine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          write(first.cwd, ".gitignore", "notes/\n.env\n*.sqlite\n");
          write(first.cwd, "src/app.ts", "export {};\n");
          write(first.cwd, "notes/plan.md", "# The plan\n");
          const secret = "API_KEY=sk-live-1234\nPORT=3000\n";
          write(first.cwd, ".env", secret);
          NodeFS.writeFileSync(
            NodePath.join(first.cwd, "local.sqlite"),
            Buffer.from([0, 1, 2, 255]),
          );
          yield* first.runner.autosave;
          yield* first.runner.flush;

          const { wip, machine } = drive.refs("t1");
          expect(machine).not.toBeNull();
          // The auto-save is what git tracks; the rest is the thread's machine state.
          expect(filesOf(drive.store, wip!)).toEqual([".gitignore", "src/app.ts"]);
          expect(filesOf(drive.store, machine!)).toEqual([
            "checkout/.env",
            "checkout/local.sqlite",
            "checkout/notes/plan.md",
            "dependencies.json",
          ]);

          const turn = yield* first.runner.finishTurn({ message: "Start" });
          expect(turn.outcome._tag).toBe("landed");
          const { thread, main } = drive.refs("t1");
          expect(filesOf(drive.store, thread!)).toEqual([".gitignore", "src/app.ts"]);
          expect(filesOf(drive.store, main!)).toEqual([".gitignore", "src/app.ts"]);

          // The first machine is gone; a new one picks the thread up.
          const second = yield* threadMachine(drive, root, "vm-2", "t1");
          yield* second.runner.prepare("remote-token");
          expect(read(second.cwd, "notes/plan.md")).toBe("# The plan\n");
          expect(read(second.cwd, ".env")).toBe(secret);
          expect([...NodeFS.readFileSync(NodePath.join(second.cwd, "local.sqlite"))]).toEqual([
            0, 1, 2, 255,
          ]);
          // Restored files stay ignored, as they were.
          expect(git(second.cwd, "status", "--porcelain")).toBe("");
        }),
      ),
  );

  it.effect("keeps a thread's machine state from every other thread in the drive", () =>
    run((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const a = yield* threadMachine(drive, root, "vm-a", "ta");
        yield* a.runner.prepare("remote-token");
        write(a.cwd, ".gitignore", ".env\n");
        write(a.cwd, ".env", "TOKEN=only-for-ta\n");
        yield* a.runner.finishTurn({ message: "Ignore .env" });
        const secretBlob = git(a.cwd, "hash-object", ".env");

        const b = yield* threadMachine(drive, root, "vm-b", "tb");
        yield* b.runner.prepare("remote-token");
        expect(read(b.cwd, ".gitignore")).toBe(".env\n");
        expect(exists(b.cwd, ".env")).toBe(false);
        expect(drive.objectsVisibleTo("tb").has(secretBlob)).toBe(false);
        expect(drive.objectsVisibleTo("ta").has(secretBlob)).toBe(true);
        expect(drive.refs("tb").machine).toBeNull();
      }),
    ),
  );

  it.effect("stores a second thread's own changes only", () =>
    run((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const a = yield* threadMachine(drive, root, "vm-a", "ta");
        yield* a.runner.prepare("remote-token");
        write(a.cwd, ".gitignore", "data/\n");
        write(a.cwd, "README.md", "# Project\n");
        write(a.cwd, "src/big.ts", "x".repeat(10_000));
        write(a.cwd, "data/a.csv", "1,2,3\n");
        yield* a.runner.finishTurn({ message: "Project" });

        const b = yield* threadMachine(drive, root, "vm-b", "tb");
        yield* b.runner.prepare("remote-token");
        const mainObjects = new Set(
          git(drive.store, "rev-list", "--objects", drive.refs("tb").main!)
            .split("\n")
            .map((line) => line.slice(0, 40)),
        );
        write(b.cwd, "data/b.csv", "4,5,6\n");
        yield* b.runner.autosave;
        yield* b.runner.flush;

        const own = drive.privateObjectsOf("tb");
        // The data file, its folders, the manifest and the commit: nothing main already holds.
        expect(own.filter((oid) => mainObjects.has(oid))).toEqual([]);
        expect(own).toContain(git(b.cwd, "hash-object", "data/b.csv"));
        expect(own).not.toContain(git(a.cwd, "hash-object", "data/a.csv"));
        expect(own.length).toBeLessThanOrEqual(6);

        // Nothing changed: nothing more is stored.
        const packs = drive.packs.length;
        yield* b.runner.autosave;
        yield* b.runner.flush;
        expect(drive.packs.length).toBe(packs);
      }),
    ),
  );

  it.effect(
    "brings the thread's home back, and never the Runner's own files or session mirrors",
    () =>
      run((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const first = yield* threadMachine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          write(first.home, ".local/bin/tool", "#!/bin/sh\necho hi\n");
          NodeFS.chmodSync(NodePath.join(first.home, ".local/bin/tool"), 0o755);
          NodeFS.symlinkSync("bin/tool", NodePath.join(first.home, ".local/tool-link"));
          write(first.home, ".config/tool/config.toml", "answer = 42\n");
          write(first.home, ".cache/tool/blob", "cached");
          write(first.claude, "projects/session.jsonl", "{}\n");
          write(first.claude, "todos/list.json", "[]\n");
          yield* first.runner.autosave;
          yield* first.runner.flush;

          const machine = drive.refs("t1").machine!;
          expect(filesOf(drive.store, machine)).toEqual([
            "dependencies.json",
            "outside/claude/todos/list.json",
            "outside/home/.config/tool/config.toml",
            "outside/home/.local/bin/tool",
            "outside/home/.local/tool-link",
          ]);

          const second = yield* threadMachine(drive, root, "vm-2", "t1");
          yield* second.runner.prepare("remote-token");
          expect(read(second.home, ".local/bin/tool")).toBe("#!/bin/sh\necho hi\n");
          expect(
            NodeFS.statSync(NodePath.join(second.home, ".local/bin/tool")).mode & 0o111,
          ).not.toBe(0);
          expect(NodeFS.readlinkSync(NodePath.join(second.home, ".local/tool-link"))).toBe(
            "bin/tool",
          );
          expect(read(second.home, ".config/tool/config.toml")).toBe("answer = 42\n");
          expect(read(second.claude, "todos/list.json")).toBe("[]\n");
          // The new machine's own settings stand.
          expect(read(second.claude, "settings.json")).toBe(`{"apiKeyHelper":"cat vm-2"}`);
          expect(exists(second.claude, "projects/session.jsonl")).toBe(false);
          expect(exists(second.home, ".cache/tool/blob")).toBe(false);
        }),
      ),
  );

  it.effect(
    "brings Codex's own state back, but not its indexes of the rollouts the store restores",
    () =>
      run((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          // A light machine that saved before the indexes were left out (#644).
          const savedBefore = (layout: MachineLayout) =>
            outsideFolders(layout).map((folder) =>
              folder.name === "codex"
                ? {
                    ...folder,
                    exclude: folder.exclude.filter((file) => !CODEX_ROLLOUT_INDEXES.includes(file)),
                  }
                : folder,
            );
          const first = yield* threadMachine(drive, root, "light", "t1", { outside: savedBefore });
          yield* first.runner.prepare("remote-token");
          const rollout = "sessions/2026/10/16/rollout-2026-10-16T16-55-01-thread-1.jsonl";
          write(first.codex, rollout, "{}\n");
          // Codex's indexes name each rollout by its absolute path on this machine: on one
          // where that path isn't, `thread/resume` finds no rollout.
          for (const file of CODEX_ROLLOUT_INDEXES)
            write(first.codex, file, NodePath.join(first.codex, rollout));
          write(first.codex, "goals_1.sqlite", "goal");
          yield* first.runner.autosave;
          yield* first.runner.flush;
          expect(filesOf(drive.store, drive.refs("t1").machine!)).toContain(
            "outside/codex/state_5.sqlite",
          );

          const second = yield* threadMachine(drive, root, "heavy", "t1");
          yield* second.runner.prepare("remote-token");
          expect(read(second.codex, "goals_1.sqlite")).toBe("goal");
          for (const file of CODEX_ROLLOUT_INDEXES) expect(exists(second.codex, file)).toBe(false);

          // Codex rebuilds them here; the next save leaves them out.
          for (const file of CODEX_ROLLOUT_INDEXES) write(second.codex, file, "rebuilt");
          yield* second.runner.autosave;
          yield* second.runner.flush;
          expect(filesOf(drive.store, drive.refs("t1").machine!)).toEqual([
            "dependencies.json",
            "outside/codex/goals_1.sqlite",
          ]);
        }),
      ),
  );

  it.effect(
    "leaves dependency trees to their recipe, keeping only files edited after the install",
    () =>
      run((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          let trees: ReadonlyArray<DependencyTree> = [];
          const first = yield* threadMachine(drive, root, "vm-1", "t1", { trees: () => trees });
          yield* first.runner.prepare("remote-token");
          const recipe = "pnpm install --frozen-lockfile, from pnpm-lock.yaml";
          trees = [installedTree(first.cwd, "node_modules", recipe)];
          write(first.cwd, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
          write(first.cwd, "node_modules/pkg/index.js", "module.exports = 1;\n");
          write(first.cwd, "node_modules/pkg/patched.js", "original\n");
          write(first.cwd, "node_modules/.cache/tool/entry", "cache");
          // Long before this test: the install, and what it laid down.
          const past = 1_700_000_000;
          for (const file of ["pkg/index.js", "pkg/patched.js", ".cache/tool/entry"]) {
            NodeFS.utimesSync(NodePath.join(first.cwd, "node_modules", file), past, past);
          }
          write(first.cwd, "node_modules/.signalbox-dependencies.json", "{}");
          NodeFS.utimesSync(
            NodePath.join(first.cwd, "node_modules/.signalbox-dependencies.json"),
            past,
            past,
          );
          // The agent patches a dependency after it was installed.
          write(first.cwd, "node_modules/pkg/patched.js", "patched by the agent\n");
          // A node_modules nothing rebuilds is kept like any other folder.
          write(first.cwd, "vendor/node_modules/lib/index.js", "kept\n");
          const turn = yield* first.runner.finishTurn({ message: "Patch" });
          expect(turn.checkpoint?.skipped).toEqual([{ path: "node_modules", recipe }]);

          const machine = drive.refs("t1").machine!;
          // The branch never holds a node_modules; one nothing rebuilds stays in the machine state.
          expect(filesOf(drive.store, machine)).toEqual([
            "checkout/node_modules/pkg/patched.js",
            "checkout/vendor/node_modules/lib/index.js",
            "dependencies.json",
          ]);

          // A new machine: the edit waits until the recipe rebuilt the tree at the same key.
          const second = yield* threadMachine(drive, root, "vm-2", "t1", { trees: () => trees });
          trees = [];
          yield* second.runner.prepare("remote-token");
          expect(exists(second.cwd, "node_modules/pkg/patched.js")).toBe(false);
          write(second.cwd, "node_modules/pkg/patched.js", "original\n");
          trees = [installedTree(second.cwd, "node_modules", recipe)];
          yield* second.runner.restoreDependencyEdits;
          expect(read(second.cwd, "node_modules/pkg/patched.js")).toBe("patched by the agent\n");

          // Rebuilt from another lockfile, the edit no longer applies.
          const third = yield* threadMachine(drive, root, "vm-3", "t1", { trees: () => trees });
          yield* third.runner.prepare("remote-token");
          write(third.cwd, "node_modules/pkg/patched.js", "original\n");
          trees = [
            {
              ...installedTree(third.cwd, "node_modules", recipe),
              installed: { inputs: "key-2", record: "unused" },
            },
          ];
          yield* third.runner.restoreDependencyEdits;
          expect(read(third.cwd, "node_modules/pkg/patched.js")).toBe("original\n");
        }),
      ),
  );

  it.effect("leaves build output beside its project file out, and says so", () =>
    run((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* threadMachine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare("remote-token");
        write(first.cwd, ".gitignore", "target/\nnotes/\n");
        write(first.cwd, "tools/[id]/Cargo.toml", "[package]\n");
        write(first.cwd, "tools/[id]/target/debug/app", "binary");
        // No project file beside it: someone's own folder, kept.
        write(first.cwd, "notes/target/plan.md", "# Plan\n");
        // A repository of its own inside the checkout.
        write(first.cwd, "notes/clone/README.md", "# Clone\n");
        git(NodePath.join(first.cwd, "notes/clone"), "init", "-q");
        const turn = yield* first.runner.finishTurn({ message: "Tools" });
        expect(turn.checkpoint?.skipped).toEqual([
          { path: "tools/[id]/target", recipe: "Build output: cargo builds it again" },
          { path: "notes/clone", recipe: "A repository of its own: its history isn't kept here" },
        ]);
        expect(filesOf(drive.store, drive.refs("t1").machine!)).toEqual([
          "checkout/notes/target/plan.md",
          "dependencies.json",
        ]);
      }),
    ),
  );

  it.effect("knows when anything it keeps changed since the last save, and nothing else", () =>
    run((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* threadMachine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare("remote-token");
        write(first.cwd, ".gitignore", "notes/\n");
        yield* first.runner.saveNow;
        expect(yield* first.runner.changed).toBe(false);

        // Written after the turn, by a dev server say: not saved yet.
        write(first.cwd, "notes/log.md", "started\n");
        expect(yield* first.runner.changed).toBe(true);
        yield* first.runner.saveNow;
        expect(yield* first.runner.changed).toBe(false);
        expect(filesOf(drive.store, drive.refs("t1").machine!)).toContain("checkout/notes/log.md");

        // A removed file is a change too.
        NodeFS.rmSync(NodePath.join(first.cwd, "notes/log.md"));
        expect(yield* first.runner.changed).toBe(true);
        // Folders tools write their caches into, there before the save.
        write(first.cwd, "node_modules/.vite/deps/a.js", "");
        NodeFS.mkdirSync(NodePath.join(first.claude, "projects"));
        NodeFS.mkdirSync(NodePath.join(first.home, ".cache"));
        yield* first.runner.saveNow;

        // Caches, dependency trees and what the Runner saves another way are no change.
        write(first.cwd, "node_modules/.vite/deps/a.js", "optimized");
        write(first.claude, "projects/session.jsonl", "{}\n");
        write(first.home, ".cache/tool/blob", "cached");
        expect(yield* first.runner.changed).toBe(false);

        // The thread's home is.
        write(first.home, ".config/tool/config.toml", "answer = 42\n");
        expect(yield* first.runner.changed).toBe(true);
      }),
    ),
  );

  it.effect("keeps what the thread's own excludes ignore out of the branch on a new machine", () =>
    run((root) =>
      Effect.gen(function* () {
        const drive = makeFakeDrive(root);
        const first = yield* threadMachine(drive, root, "vm-1", "t1");
        yield* first.runner.prepare("remote-token");
        write(first.cwd, "src/app.ts", "export {};\n");
        // Ignored by the repository's own excludes, not by a .gitignore.
        NodeFS.appendFileSync(NodePath.join(first.cwd, ".git", "info", "exclude"), ".env\n");
        write(first.cwd, ".env", "SECRET=leak\n");
        yield* first.runner.finishTurn({ message: "one" });
        expect(filesOf(drive.store, drive.refs("t1").main!)).toEqual(["src/app.ts"]);

        const second = yield* threadMachine(drive, root, "vm-2", "t1");
        yield* second.runner.prepare("remote-token");
        expect(read(second.cwd, ".env")).toBe("SECRET=leak\n");
        expect(git(second.cwd, "status", "--porcelain")).toBe("");
        write(second.cwd, "src/app.ts", "export const x = 1;\n");
        yield* second.runner.autosave;
        yield* second.runner.flush;
        expect(filesOf(drive.store, drive.refs("t1").wip!)).toEqual(["src/app.ts"]);
        yield* second.runner.finishTurn({ message: "two" });
        expect(filesOf(drive.store, drive.refs("t1").main!)).toEqual(["src/app.ts"]);
        expect(drive.objectsVisibleTo("t9").has(git(second.cwd, "hash-object", ".env"))).toBe(
          false,
        );
      }),
    ),
  );

  it.effect(
    "never saves a restored file nothing ignores anymore, unless someone un-ignores it",
    () =>
      run((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const first = yield* threadMachine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          write(first.cwd, ".gitignore", ".env\n");
          write(first.cwd, ".env", "SECRET=leak\n");
          yield* first.runner.autosave;
          yield* first.runner.flush;
          // The auto-save that held the .gitignore never landed; the machine state did.
          drive.forceRef("t1", "wip", null);

          const second = yield* threadMachine(drive, root, "vm-2", "t1");
          yield* second.runner.prepare("remote-token");
          expect(read(second.cwd, ".env")).toBe("SECRET=leak\n");
          expect(exists(second.cwd, ".gitignore")).toBe(false);
          write(second.cwd, "src/app.ts", "export {};\n");
          yield* second.runner.finishTurn({ message: "two" });
          expect(filesOf(drive.store, drive.refs("t1").main!)).toEqual(["src/app.ts"]);

          // Un-ignored on purpose, it's the thread's to commit.
          write(second.cwd, ".gitignore", "!.env\n");
          yield* second.runner.finishTurn({ message: "three" });
          expect(filesOf(drive.store, drive.refs("t1").main!)).toEqual([
            ".env",
            ".gitignore",
            "src/app.ts",
          ]);
        }),
      ),
  );

  it.effect(
    "keeps no machine state on a cloud from before it, so nothing private goes public",
    () =>
      run((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root, { machineState: false });
          const first = yield* threadMachine(drive, root, "vm-1", "t1");
          yield* first.runner.prepare("remote-token");
          write(first.cwd, ".gitignore", ".env\n");
          write(first.cwd, ".env", "SECRET=1\n");
          yield* first.runner.autosave;
          yield* first.runner.flush;
          expect(drive.refs("t1").wip).not.toBeNull();
          expect(drive.packs.every((pack) => pack.owner === undefined)).toBe(true);
        }),
      ),
  );
});
