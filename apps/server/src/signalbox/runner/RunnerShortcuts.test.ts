// @effect-diagnostics nodeBuiltinImport:off - the assertions read the machine's files and run real git.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type FakeDrive,
  git,
  gitOk,
  machine,
  makeFakeDrive,
  read,
  scopedTest,
  status,
  write,
} from "./driveTesting.ts";
import { INSTRUCTIONS_MAX_BYTES, ROOT_MARKER } from "./RunnerInstructions.ts";

/** Lands `files` on `drive`'s main through a thread of its own, as a person working in it would. */
const land = (drive: FakeDrive, root: string, files: Record<string, string>, message: string) =>
  Effect.gen(function* () {
    const { runner, cwd } = yield* machine(drive, root, `author-${drive.id}`, `author-${drive.id}`);
    yield* runner.prepare(null);
    for (const [file, text] of Object.entries(files)) write(cwd, file, text);
    const turn = yield* runner.finishTurn({ message });
    expect(turn.outcome._tag).toBe("landed");
  });

const writable = (file: string) => {
  try {
    NodeFS.accessSync(file, NodeFS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** The bundle a machine wrote above the thread's checkout, or null. */
const bundle = (cwd: string) => {
  const file = NodePath.join(NodePath.dirname(cwd), "AGENTS.md");
  return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null;
};

describe("RunnerShortcuts", () => {
  it.effect(
    "mounts each shortcut read-only with its own history, outside the drive, and bundles their instructions",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const home = makeFakeDrive(root, { id: "home" });
          const code = makeFakeDrive(root, { id: "code" });
          const docs = makeFakeDrive(root, { id: "docs" });
          yield* land(code, root, { "AGENTS.md": "CODE RULES\n", "src/app.ts": "one\n" }, "Code");
          yield* land(code, root, { "src/app.ts": "two\n" }, "Code again");
          yield* land(docs, root, { "AGENTS.md": "DOCS RULES\n", "guide.md": "read me\n" }, "Docs");
          yield* land(home, root, { "AGENTS.md": "HOME RULES\n", "notes.md": "hi\n" }, "Home");
          home.shortcuts.push(
            { path: "code", target: code, readable: true },
            { path: "team/docs", target: docs, readable: true },
          );

          const { runner, cwd } = yield* machine(home, root, "vm-1", "t1");
          const prepared = yield* runner.prepare("remote-token");

          expect(read(cwd, "code/src/app.ts")).toBe("two\n");
          expect(read(cwd, "team/docs/guide.md")).toBe("read me\n");
          // Its own history, not the drive's.
          expect(git(NodePath.join(cwd, "code"), "log", "--format=%s")).toBe("Code again\nCode");
          expect(writable(NodePath.join(cwd, "code/src/app.ts"))).toBe(false);
          expect(writable(NodePath.join(cwd, "code/src"))).toBe(false);
          expect(writable(NodePath.join(cwd, "notes.md"))).toBe(true);
          expect(status(cwd)).toEqual([]);

          // Instructions: one bundle above the checkout, the drive's own left alone.
          const text = bundle(cwd)!;
          expect(prepared.instructions).toBe(text);
          expect(text).toContain("## `code/`");
          expect(text).toContain("CODE RULES");
          expect(text).toContain("## `team/docs/`");
          expect(text).toContain("DOCS RULES");
          expect(text.indexOf("CODE RULES")).toBeLessThan(text.indexOf("DOCS RULES"));
          expect(text).not.toContain("HOME RULES");
          expect(read(cwd, "AGENTS.md")).toBe("HOME RULES\n");
          expect(NodeFS.existsSync(NodePath.join(NodePath.dirname(cwd), ROOT_MARKER))).toBe(true);

          // A turn never saves anything under a shortcut.
          write(cwd, "notes.md", "changed\n");
          const turn = yield* runner.finishTurn({ message: "Edit notes" });
          expect(turn.outcome._tag).toBe("landed");
          expect(git(home.store, "ls-tree", "-r", "--name-only", home.refs("t1").main!)).toBe(
            "AGENTS.md\nnotes.md",
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("follows the target's latest version and drops what is gone at the next turn", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const home = makeFakeDrive(root, { id: "home" });
        const code = makeFakeDrive(root, { id: "code" });
        const docs = makeFakeDrive(root, { id: "docs" });
        yield* land(code, root, { "AGENTS.md": "CODE RULES\n" }, "Code");
        yield* land(docs, root, { "AGENTS.md": "DOCS RULES\n" }, "Docs");
        home.shortcuts.push(
          { path: "code", target: code, readable: true },
          { path: "team/docs", target: docs, readable: true },
        );
        const { runner, cwd } = yield* machine(home, root, "vm-1", "t1");
        const first = yield* runner.prepare("remote-token");

        // The target moves on: the mount follows, fetching only the new packs.
        yield* land(code, root, { "AGENTS.md": "CODE RULES v2\n" }, "Code v2");
        // One shortcut is removed, and the user loses access to the other's drive.
        home.shortcuts.splice(0, home.shortcuts.length, {
          path: "code",
          target: code,
          readable: true,
        });
        const second = yield* runner.prepare("remote-token");
        expect(read(cwd, "code/AGENTS.md")).toBe("CODE RULES v2\n");
        // The folder it sat in goes too, now that it's empty.
        expect(NodeFS.existsSync(NodePath.join(cwd, "team"))).toBe(false);
        expect(second.instructions).not.toBe(first.instructions);
        expect(second.instructions).toContain("CODE RULES v2");
        expect(second.instructions).not.toContain("DOCS RULES");

        home.shortcuts[0]!.readable = false;
        const third = yield* runner.prepare("remote-token");
        expect(NodeFS.existsSync(NodePath.join(cwd, "code"))).toBe(false);
        expect(third.notices).toEqual([
          "code is gone from this thread: you can't open the drive it showed anymore.",
        ]);
        expect(third.instructions).toBe("");
        expect(bundle(cwd)).toBeNull();
        expect(status(cwd)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("a folder split out after a thread changed it never lands back in the drive", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const home = makeFakeDrive(root, { id: "home" });
        const shared = makeFakeDrive(root, { id: "shared" });
        yield* land(home, root, { "notes.md": "hi\n", "shared/plan.md": "v1\n" }, "Start");
        const { runner, cwd } = yield* machine(home, root, "vm-1", "t1");
        yield* runner.prepare("remote-token");
        write(cwd, "shared/plan.md", "v2 from the thread\n");
        write(cwd, "shared/new.md", "added by the thread\n");
        yield* runner.autosave;
        yield* runner.flush;

        // Sharing the folder: it becomes its own drive, and main drops it for a shortcut.
        yield* land(shared, root, { "plan.md": "v1\n" }, "Split");
        const owner = yield* machine(home, root, "vm-owner", "owner");
        yield* owner.runner.prepare(null);
        NodeFS.rmSync(NodePath.join(owner.cwd, "shared"), { recursive: true });
        expect((yield* owner.runner.finishTurn({ message: "Share shared/" })).outcome._tag).toBe(
          "landed",
        );
        home.shortcuts.push({ path: "shared", target: shared, readable: true });

        const next = yield* runner.prepare("remote-token");
        expect(next.notices).toEqual([
          "Files under shared aren't saved in this drive anymore: shared shows another drive now. This thread's history keeps them.",
        ]);
        expect(read(cwd, "shared/plan.md")).toBe("v1\n");
        expect(NodeFS.existsSync(NodePath.join(cwd, "shared/new.md"))).toBe(false);
        const turn = yield* runner.finishTurn({ message: "Carry on" });
        expect(turn.outcome._tag).toBe("landed");
        const main = home.refs("t1").main!;
        expect(git(home.store, "ls-tree", "-r", "--name-only", main)).toBe("notes.md");
        // The thread's own history still has its edit.
        expect(gitOk(cwd, "log", "--all", "-S", "v2 from the thread", "--oneline")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect(
    "takes a shortcut's path literally, and mounts a second shortcut to a mounted drive in full",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const home = makeFakeDrive(root, { id: "home" });
          const code = makeFakeDrive(root, { id: "code" });
          yield* land(home, root, { "notes.md": "hi\n", "plan/a.md": "a\n" }, "Home");
          yield* land(code, root, { "AGENTS.md": "CODE RULES\n" }, "Code");
          yield* land(code, root, { "src/app.ts": "one\n" }, "More code");
          // A folder named `*` must not match every file of the drive.
          home.shortcuts.push({ path: "*", target: code, readable: true });
          const { runner, cwd } = yield* machine(home, root, "vm-1", "t1");
          const first = yield* runner.prepare("remote-token");
          expect(first.notices).toEqual([]);
          expect(read(cwd, "*/src/app.ts")).toBe("one\n");
          expect(status(cwd)).toEqual([]);

          // The same drive again elsewhere: its packs come from the start for the new mount.
          home.shortcuts.push({ path: "again", target: code, readable: true });
          yield* runner.prepare("remote-token");
          expect(read(cwd, "again/src/app.ts")).toBe("one\n");
          write(cwd, "notes.md", "changed\n");
          expect((yield* runner.finishTurn({ message: "Edit" })).outcome._tag).toBe("landed");
          expect(git(home.store, "ls-tree", "-r", "--name-only", home.refs("t1").main!)).toBe(
            "notes.md\nplan/a.md",
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("fails the turn loudly when the instructions are over the cap", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const home = makeFakeDrive(root, { id: "home" });
        const big = makeFakeDrive(root, { id: "big" });
        yield* land(home, root, { "AGENTS.md": "HOME RULES\n" }, "Home");
        yield* land(big, root, { "AGENTS.md": `${"x".repeat(INSTRUCTIONS_MAX_BYTES)}\n` }, "Big");
        home.shortcuts.push({ path: "big", target: big, readable: true });
        const { runner, cwd } = yield* machine(home, root, "vm-1", "t1");

        const error = yield* Effect.flip(runner.prepare("remote-token"));
        expect(error._tag).toBe("RunnerInstructionsError");
        expect(error.message).toMatch(
          /^This drive's instructions come to 64\.\d KiB, over the 64\.0 KiB agents can load: AGENTS\.md 11 bytes, big\/AGENTS\.md 64\.0 KiB\. Shorten them or remove a shortcut/,
        );
        expect(bundle(cwd)).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ),
  );
});
