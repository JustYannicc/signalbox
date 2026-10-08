// @effect-diagnostics nodeBuiltinImport:off - the remote is a real bare repository fed by git receive-pack.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "./DriveDirectory.ts";
import { MAIN_REF, threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import { packForPush, receivePackRequest, receivePackResult } from "./gitPush.ts";
import type { Bytes } from "./git/gitObjects.ts";

const DRIVE = "project/user_1/project-1";
const REMOTE = { provider: "github", repository: "owner/repo", defaultBranch: "main" } as const;
const writer = (threadId: string, live = true) => ({
  threadId,
  generation: 1,
  live,
  packsAfter: 0,
});

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
  GIT_AUTHOR_NAME: "Someone",
  GIT_AUTHOR_EMAIL: "someone@example.com",
  GIT_COMMITTER_NAME: "Someone",
  GIT_COMMITTER_EMAIL: "someone@example.com",
};
const run = (cwd: string, args: ReadonlyArray<string>, input?: Uint8Array) =>
  NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, input });
const gitOk = (cwd: string, args: ReadonlyArray<string>) => {
  try {
    run(cwd, args);
    return true;
  } catch {
    return false;
  }
};

/**
 * GitHub, as far as a drive can tell: a repository with history, a bare copy
 * that takes pushes, and a machine's clone of it one commit deep.
 */
const setup = () => {
  const upstream = makeRepo();
  cleanups.push(upstream.cleanup);
  upstream.write("README.md", "hello\n");
  upstream.commit("first");
  upstream.write("src/app.ts", "export {}\n");
  const head = upstream.commit("second");
  const github = tempDir("remote-github-");
  run(github, ["clone", "-q", "--bare", upstream.dir, "."]);
  const machine = tempDir("remote-machine-");
  run(machine, ["clone", "-q", "--depth=1", `file://${upstream.dir}`, "."]);
  const git = (args: ReadonlyArray<string>, input?: string) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: machine,
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_NAME: "Signalbox",
        GIT_AUTHOR_EMAIL: "agent@signalbox.invalid",
        GIT_COMMITTER_NAME: "Signalbox",
        GIT_COMMITTER_EMAIL: "agent@signalbox.invalid",
      },
      input,
      encoding: "utf8",
    }).trim();
  /** A pack of what `include` reaches past `exclude`, as the Runner uploads it. */
  const pack = (include: ReadonlyArray<string>, exclude: ReadonlyArray<string> = []) => {
    const out = tempDir("remote-pack-");
    const name = git(
      ["pack-objects", "--revs", "--delta-base-offset", NodePath.join(out, "pack")],
      [...include, ...exclude.map((oid) => `^${oid}`)].join("\n") + "\n",
    );
    const read = (ext: string): Bytes =>
      new Uint8Array(NodeFS.readFileSync(NodePath.join(out, `pack-${name}.${ext}`)));
    return { pack: read("pack"), idx: read("idx") };
  };
  const commit = (file: string, text: string, message: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(machine, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(machine, file), text);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  return { upstream, github, machine, head, git, pack, commit };
};

describe("a drive backed by a remote", () => {
  it.effect("holds the remote's head one commit deep, and main only mirrors it", () =>
    Effect.gen(function* () {
      const remote = setup();
      const handle = (yield* DriveDirectory).forDrive(DRIVE);
      yield* handle.setRemote(REMOTE);
      const packed = remote.pack([remote.head]);
      const upload = (remoteHead?: string) =>
        uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...packed,
          ...(remoteHead === undefined ? {} : { remoteHead }),
        });
      // Its parent is on the remote, not in the drive: only a checked remote head may lean on that.
      expect((yield* upload())._tag).toBe("refused");
      expect((yield* upload(remote.head))._tag).toBe("ok");
      expect((yield* handle.refs("t1")).shallow).toEqual([remote.head]);

      const idle = yield* handle.mirror(writer("t1", false), {
        expectedMain: null,
        newMain: remote.head,
      });
      expect(idle._tag).toBe("refused");
      const mirrored = yield* handle.mirror(writer("t1"), {
        expectedMain: null,
        newMain: remote.head,
      });
      expect(mirrored).toMatchObject({ _tag: "ok", refs: { main: remote.head, remote: REMOTE } });
      const opened = yield* handle.open(writer("t2"));
      expect(opened).toMatchObject({
        _tag: "ok",
        refs: { thread: remote.head, base: remote.head },
      });
      // Work lands on the remote, never by moving main from a thread.
      const reconciled = yield* handle.reconcile(writer("t2"), {
        expectedMain: remote.head,
        newMain: remote.head,
      });
      expect(reconciled).toMatchObject({ _tag: "refused" });

      const own = (yield* DriveDirectory).forDrive("my/personal/user_1");
      const noRemote = yield* own.mirror(writer("t1"), {
        expectedMain: null,
        newMain: remote.head,
      });
      expect(noRemote).toMatchObject({ _tag: "refused" });
    }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it.effect("pushes a thread's branch to the remote, and never its auto-saves", () =>
    Effect.gen(function* () {
      const remote = setup();
      const handle = (yield* DriveDirectory).forDrive(DRIVE);
      yield* handle.setRemote(REMOTE);
      yield* uploadPack({
        driveId: DRIVE,
        threadId: "t1",
        ...remote.pack([remote.head]),
        remoteHead: remote.head,
      });
      yield* handle.mirror(writer("t1"), { expectedMain: null, newMain: remote.head });
      yield* handle.open(writer("t1"));

      // A turn's commit, then an auto-save of an edit made after it.
      const turn = remote.commit("src/app.ts", "export const app = 1;\n", "Add app");
      NodeFS.writeFileSync(NodePath.join(remote.machine, "secret-draft.md"), "not for GitHub\n");
      remote.git(["add", "-A"]);
      const draftTree = remote.git(["write-tree"]);
      const autosave = remote.git(["commit-tree", draftTree, "-p", turn, "-m", "Auto-save"]);
      const draftBlob = remote.git(["rev-parse", `${autosave}:secret-draft.md`]);
      yield* uploadPack({
        driveId: DRIVE,
        threadId: "t1",
        ...remote.pack([autosave], [remote.head]),
      });
      yield* handle.updateRefs(writer("t1"), [
        { name: threadRef("t1"), old: remote.head, new: turn },
        { name: wipRef("t1"), old: null, new: autosave },
      ]);

      const push = (head: string, old: string | null) =>
        Effect.gen(function* () {
          const packed = yield* packForPush({
            driveId: DRIVE,
            head,
            old,
            remoteHas: [remote.head],
          });
          const ref = "refs/heads/signalbox/t1";
          const answer = run(
            remote.github,
            ["receive-pack", "--stateless-rpc", "."],
            receivePackRequest({ ref, old, next: head, pack: packed.pack }),
          );
          return { ...packed, result: receivePackResult(new Uint8Array(answer), ref) };
        });

      const first = yield* push(turn, null);
      expect(first.result).toEqual({ _tag: "ok" });
      expect(first.commits).toBe(1);
      const pushed = run(remote.github, ["rev-parse", "refs/heads/signalbox/t1"]).toString().trim();
      expect(pushed).toBe(turn);
      expect(gitOk(remote.github, ["fsck", "--connectivity-only", "--no-dangling"])).toBe(true);
      expect(gitOk(remote.github, ["cat-file", "-e", autosave])).toBe(false);
      expect(gitOk(remote.github, ["cat-file", "-e", draftBlob])).toBe(false);

      // The next push sends only what came after.
      const next = remote.commit("README.md", "hello again\n", "Update readme");
      yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...remote.pack([next], [turn]) });
      const second = yield* push(next, turn);
      expect(second.result).toEqual({ _tag: "ok" });
      expect(second.commits).toBe(1);
      expect(run(remote.github, ["rev-parse", "refs/heads/signalbox/t1"]).toString().trim()).toBe(
        next,
      );

      // Someone else pushed to the branch: nothing of theirs is overwritten.
      const elsewhere = run(remote.github, [
        "commit-tree",
        `${next}^{tree}`,
        "-p",
        next,
        "-m",
        "From someone else",
      ])
        .toString()
        .trim();
      const refused = yield* packForPush({
        driveId: DRIVE,
        head: next,
        old: elsewhere,
        remoteHas: [remote.head],
      }).pipe(Effect.flip);
      expect(refused._tag).toBe("PushRefused");
      expect(yield* handle.ref(MAIN_REF)).toBe(remote.head);
    }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it("reads a remote's refusal", () => {
    const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
    const body = new TextEncoder().encode(
      `${line("unpack ok\n")}${line("ng refs/heads/x protected branch hook declined\n")}0000`,
    );
    expect(receivePackResult(body, "refs/heads/x")).toEqual({
      _tag: "refused",
      reason: "protected branch hook declined",
    });
  });
});
