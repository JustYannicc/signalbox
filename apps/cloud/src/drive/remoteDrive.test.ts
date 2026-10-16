// @effect-diagnostics nodeBuiltinImport:off - the remote is a real bare repository fed by git receive-pack.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DriveDirectory } from "./DriveDirectory.ts";
import { MAIN_REF, threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { makeDriveReader } from "./DriveReader.ts";
import { uploadPack } from "./DriveUploads.ts";
import {
  GITHUB_LIMITS,
  type HostLimits,
  packForPush,
  receivePackRequest,
  receivePackResult,
} from "./gitPush.ts";
import { type Bytes, concatBytes } from "./git/gitObjects.ts";

const DRIVE = "shared/personal/repo1";
const MANAGER = { userId: "user_1", email: "a@b.c", name: null, role: "manager" } as const;
const REMOTE = { provider: "github", repository: "owner/repo", defaultBranch: "main" } as const;
const writer = (threadId: string, live = true) => ({
  threadId,
  userId: "user_1",
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

/** Sends `packed` to the bare repository `github` as `git push` would, checking it is the size it said. */
const receive = <E>(
  github: string,
  input: {
    readonly ref: string;
    readonly old: string | null;
    readonly next: string;
    readonly packed: { readonly pack: Stream.Stream<Uint8Array, E>; readonly size: number };
  },
) =>
  Effect.gen(function* () {
    const request = receivePackRequest({
      ref: input.ref,
      old: input.old,
      next: input.next,
      pack: input.packed.pack,
      size: input.packed.size,
    });
    const body = concatBytes(yield* Stream.runCollect(request.body));
    expect(body.length).toBe(request.length);
    const answer = run(github, ["receive-pack", "--stateless-rpc", "."], body);
    return receivePackResult(new Uint8Array(answer), input.ref);
  });

/** Bytes that don't compress, as photos and datasets don't. */
const noise = (bytes: number) => NodeCrypto.randomBytes(bytes);

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
  /** A pack of what `include` reaches past `exclude`, as the Runner uploads it; `filter` leaves objects out. */
  const pack = (
    include: ReadonlyArray<string>,
    exclude: ReadonlyArray<string> = [],
    filter?: string,
  ) => {
    const out = tempDir("remote-pack-");
    const name = git(
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
  const commit = (file: string, text: string, message: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(machine, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(machine, file), text);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  return { upstream, github, machine, head, git, pack, commit };
};

const MiB = 1024 * 1024;

/** A drive backed by `remote`, holding its head as the Runner mirrors it, open for thread t1. */
const openThread = (remote: ReturnType<typeof setup>) =>
  Effect.gen(function* () {
    const handle = (yield* DriveDirectory).forDrive(DRIVE);
    yield* handle.setRemote(REMOTE);
    yield* handle.setup({ name: "owner/repo", members: [MANAGER] });
    yield* uploadPack({
      driveId: DRIVE,
      threadId: "t1",
      ...remote.pack([remote.head], [], "blob:none"),
      remoteHead: remote.head,
    });
    yield* handle.mirror(writer("t1"), { expectedMain: null, newMain: remote.head });
    yield* handle.open(writer("t1"));
    return handle;
  });

const put = (remote: ReturnType<typeof setup>, file: string, bytes: Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(remote.machine, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(remote.machine, file), bytes);
};

/** How many objects `packed` stores as deltas, as `git verify-pack` counts them. */
const deltasIn = (packed: { readonly pack: Bytes; readonly idx: Bytes }) => {
  const dir = tempDir("remote-verify-");
  NodeFS.writeFileSync(NodePath.join(dir, "pack-x.pack"), packed.pack);
  NodeFS.writeFileSync(NodePath.join(dir, "pack-x.idx"), packed.idx);
  return run(dir, ["verify-pack", "-v", "pack-x.idx"])
    .toString()
    .split("\n")
    .filter((line) => /^[0-9a-f]{40} \w+\s+\d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(line)).length;
};

describe("a drive backed by a remote", () => {
  it.effect("holds the remote's head one commit deep, and main only mirrors it", () =>
    Effect.gen(function* () {
      const remote = setup();
      const handle = (yield* DriveDirectory).forDrive(DRIVE);
      yield* handle.setRemote(REMOTE);
      yield* handle.setup({ name: "owner/repo", members: [MANAGER] });
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

  it.effect("holds the remote head's files as promised, never as a copy (#406)", () =>
    Effect.gen(function* () {
      const remote = setup();
      const handle = (yield* DriveDirectory).forDrive(DRIVE);
      yield* handle.setRemote(REMOTE);
      yield* handle.setup({ name: "owner/repo", members: [MANAGER] });
      const files = remote.git([
        "ls-tree",
        "-r",
        "--format=%(objectname) %(objectsize)",
        remote.head,
      ]);
      const sizes = new Map(
        files.split("\n").map((line) => [line.split(" ")[0]!, Number(line.split(" ")[1])]),
      );
      const blobless = remote.pack([remote.head], [], "blob:none");
      // Files left out only a checked remote head may promise.
      expect((yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...blobless }))._tag).toBe(
        "refused",
      );
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...blobless,
          remoteHead: remote.head,
          promisedSizes: Effect.succeed(sizes),
        }))._tag,
      ).toBe("ok");
      expect((yield* handle.locate([...sizes.keys()])).length).toBe(0);
      expect(
        (yield* handle.promised([...sizes.keys()])).toSorted((a, b) => a.oid.localeCompare(b.oid)),
      ).toEqual(
        [...sizes]
          .map(([oid, size]) => ({ oid, size }))
          .toSorted((a, b) => a.oid.localeCompare(b.oid)),
      );
      yield* handle.mirror(writer("t1"), { expectedMain: null, newMain: remote.head });
      yield* handle.open(writer("t1"));

      // A turn's commit leans on the promised files it didn't change.
      const turn = remote.commit("src/app.ts", "export const app = 1;\n", "Add app");
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...remote.pack([turn], [remote.head]),
        }))._tag,
      ).toBe("ok");
      // A file nobody promised, or a missing folder, is still refused.
      const stray = remote.commit("stray.txt", "not on the remote\n", "Stray");
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...remote.pack([stray], [turn], "blob:none"),
        }))._tag,
      ).toBe("refused");
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...remote.pack([stray], [turn], "tree:0"),
        }))._tag,
      ).toBe("refused");

      // Reading a promised file asks the remote, and checks what comes back.
      const readme = remote.git(["rev-parse", `${remote.head}:README.md`]);
      const fromRemote = (bytes: string) => ({
        blob: () => Effect.succeed(new TextEncoder().encode(bytes)),
      });
      // Without the remote, a promised file can't be read.
      const offline = yield* makeDriveReader(DRIVE);
      expect((yield* offline.blob(readme).pipe(Effect.flip))._tag).toBe("DriveReadError");
      const lying = yield* makeDriveReader(DRIVE, fromRemote("tampered\n"));
      expect((yield* lying.blob(readme).pipe(Effect.flip))._tag).toBe("DriveReadError");
      const reader = yield* makeDriveReader(DRIVE, fromRemote("hello\n"));
      expect(new TextDecoder().decode(yield* reader.blob(readme))).toBe("hello\n");
    }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it.effect("pushes a thread's branch to the remote, and never its auto-saves", () =>
    Effect.gen(function* () {
      const remote = setup();
      const handle = (yield* DriveDirectory).forDrive(DRIVE);
      yield* handle.setRemote(REMOTE);
      yield* handle.setup({ name: "owner/repo", members: [MANAGER] });
      // The remote's files stay on the remote (#406); pushing never needs them.
      yield* uploadPack({
        driveId: DRIVE,
        threadId: "t1",
        ...remote.pack([remote.head], [], "blob:none"),
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
            limits: GITHUB_LIMITS,
          });
          const ref = "refs/heads/signalbox/t1";
          const result = yield* receive(remote.github, { ref, old, next: head, packed });
          return { ...packed, result };
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
        limits: GITHUB_LIMITS,
      }).pipe(Effect.flip);
      expect(refused._tag).toBe("PushRefused");
      expect(yield* handle.ref(MAIN_REF)).toBe(remote.head);
    }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it.effect(
    "holds the remote commits a rebased branch sits on one deep, and pushes only its own",
    () =>
      Effect.gen(function* () {
        const remote = setup();
        const handle = (yield* DriveDirectory).forDrive(DRIVE);
        yield* handle.setRemote(REMOTE);
        yield* handle.setup({ name: "owner/repo", members: [MANAGER] });
        yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          // As the Runner mirrors it: commit and folders, the files promised (#406).
          ...remote.pack([remote.head], [], "blob:none"),
          remoteHead: remote.head,
        });
        yield* handle.mirror(writer("t1"), { expectedMain: null, newMain: remote.head });
        yield* handle.open(writer("t1"));
        // The thread's first push, on the drive's main.
        const before = remote.commit("notes.md", "mine\n", "Mine");
        yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...remote.pack([before], [remote.head]),
        });
        yield* handle.updateRefs(writer("t1"), [
          { name: threadRef("t1"), old: remote.head, new: before },
        ]);
        const ref = "refs/heads/signalbox/t1";
        const push = (head: string, old: string | null, force?: boolean) =>
          Effect.gen(function* () {
            const refs = yield* handle.refs("t1");
            const packed = yield* packForPush({
              driveId: DRIVE,
              head,
              old,
              remoteHas: [remote.head, ...refs.shallow],
              limits: GITHUB_LIMITS,
              ...(force === undefined ? {} : { force }),
            });
            const result = yield* receive(remote.github, { ref, old, next: head, packed });
            return { ...packed, result };
          });
        expect((yield* push(before, null)).result).toEqual({ _tag: "ok" });

        // Main moves on by two commits; the thread rebases onto it.
        remote.upstream.write("src/app.ts", "export const a = 1;\n");
        remote.upstream.commit("third");
        remote.upstream.write("src/app.ts", "export const a = 2;\n");
        const main = remote.upstream.commit("fourth");
        run(remote.github, ["fetch", "-q", remote.upstream.dir, "work:work"]);
        remote.git(["fetch", "-q", "--depth=1", "origin", "work"]);
        remote.git(["rebase", "-q", "--onto", main, remote.head]);
        const rebased = remote.git(["rev-parse", "HEAD"]);
        const packed = remote.pack([rebased], [before, `${before}^{tree}`]);
        // The main it sits on isn't in the drive: only a remote commit, checked as one, may lean on that.
        expect((yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...packed }))._tag).toBe(
          "refused",
        );
        expect(
          (yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...packed, remoteCommits: [main] }))
            ._tag,
        ).toBe("ok");
        expect((yield* handle.refs("t1")).shallow).toContain(main);
        yield* handle.updateRefs(writer("t1"), [
          { name: threadRef("t1"), old: before, new: rebased },
        ]);

        // The pushed branch isn't on the rebased one: refused, unless the thread took it in (a lease).
        expect((yield* push(rebased, before).pipe(Effect.flip))._tag).toBe("PushRefused");
        const forced = yield* push(rebased, before, true);
        expect(forced.result).toEqual({ _tag: "ok" });
        // Only the thread's own commit travels; GitHub has main.
        expect(forced.commits).toBe(1);
        expect(run(remote.github, ["rev-parse", ref]).toString().trim()).toBe(rebased);
        expect(gitOk(remote.github, ["fsck", "--connectivity-only", "--no-dangling"])).toBe(true);
      }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it.effect(
    "streams a branch bigger than a push could hold, files stored as deltas included (#517)",
    () =>
      Effect.gen(function* () {
        const remote = setup();
        const handle = yield* openThread(remote);
        // Two text files edited a little between two commits: one pack stores one copy of each as a
        // delta of the other. Git deltas toward the bigger copy, so the shrunk notes lean on the
        // first commit's, which the remote has by the second push, and the first commit's plan
        // leans on the grown one, which only the drive has.
        const lines = (count: number, what: string) =>
          Array.from({ length: count }, (_, i) => `line ${i} of the ${what}\n`).join("");
        put(remote, "docs/plan.md", new TextEncoder().encode(lines(2000, "plan")));
        const first = remote.commit("docs/notes.md", lines(4000, "notes"), "Add notes");
        put(remote, "media/clip.bin", noise(20 * MiB));
        put(remote, "docs/plan.md", new TextEncoder().encode(lines(3000, "plan")));
        const second = remote.commit("docs/notes.md", lines(3990, "notes"), "More");
        const packed = remote.pack([second], [remote.head]);
        expect(deltasIn(packed)).toBeGreaterThanOrEqual(2);
        yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...packed });
        const ref = "refs/heads/signalbox/t1";
        const pushed = (head: string, old: string | null) =>
          Effect.gen(function* () {
            yield* handle.updateRefs(writer("t1"), [
              { name: threadRef("t1"), old: old ?? remote.head, new: head },
            ]);
            const packed = yield* packForPush({
              driveId: DRIVE,
              head,
              old,
              remoteHas: [remote.head],
              limits: GITHUB_LIMITS,
            });
            expect(yield* receive(remote.github, { ref, old, next: head, packed })).toEqual({
              _tag: "ok",
            });
            expect(run(remote.github, ["rev-parse", ref]).toString().trim()).toBe(head);
            expect(gitOk(remote.github, ["fsck", "--no-dangling"])).toBe(true);
            return packed;
          });

        // The first commit alone: the plan's base, the second commit's copy, travels with it.
        yield* pushed(first, null);
        const big = yield* pushed(second, first);
        expect(big.size).toBeGreaterThan(20 * MiB);
        expect(
          run(remote.github, ["cat-file", "-s", `${second}:media/clip.bin`])
            .toString()
            .trim(),
        ).toBe(String(20 * MiB));
        expect(run(remote.github, ["cat-file", "blob", `${second}:docs/plan.md`]).toString()).toBe(
          lines(3000, "plan"),
        );
        // The commit, its three folders and three files: no base the remote has comes along.
        expect(big.objects).toBe(7);
      }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it.effect(
    "refuses a file bigger than the host takes before pushing, wherever in the branch",
    () =>
      Effect.gen(function* () {
        const remote = setup();
        const handle = yield* openThread(remote);
        const limits: HostLimits = { ...GITHUB_LIMITS, maxFileBytes: 1 * MiB };
        put(remote, "media/raw.bin", noise(2 * MiB));
        remote.commit("README.md", "hello there\n", "Add a recording");
        // Deleting it later leaves it in the branch's history, which the host still refuses.
        remote.git(["rm", "-q", "media/raw.bin"]);
        remote.git(["commit", "-q", "-m", "Drop the recording"]);
        const head = remote.git(["rev-parse", "HEAD"]);
        yield* uploadPack({
          driveId: DRIVE,
          threadId: "t1",
          ...remote.pack([head], [remote.head]),
        });
        yield* handle.updateRefs(writer("t1"), [
          { name: threadRef("t1"), old: remote.head, new: head },
        ]);

        const refused = yield* packForPush({
          driveId: DRIVE,
          head,
          old: null,
          remoteHas: [remote.head],
          limits,
        }).pipe(Effect.flip);
        expect(refused._tag).toBe("PushRefused");
        expect(refused.message).toContain("media/raw.bin");
        expect(refused.message).toContain("GitHub takes files up to 1 MB");
        expect(refused.message).toContain("Nothing was pushed");
        // Within the limit, the same branch goes.
        expect(
          (yield* packForPush({
            driveId: DRIVE,
            head,
            old: null,
            remoteHas: [remote.head],
            limits: GITHUB_LIMITS,
          })).objects,
        ).toBeGreaterThan(0);
      }).pipe(Effect.provide(makeMemoryDrives().layer)),
  );

  it.effect("refuses a push bigger than the host takes before sending any of it", () =>
    Effect.gen(function* () {
      const remote = setup();
      const handle = yield* openThread(remote);
      put(remote, "data/a.bin", noise(1 * MiB));
      put(remote, "data/b.bin", noise(1 * MiB));
      const head = remote.commit("README.md", "with data\n", "Add data");
      yield* uploadPack({ driveId: DRIVE, threadId: "t1", ...remote.pack([head], [remote.head]) });
      yield* handle.updateRefs(writer("t1"), [
        { name: threadRef("t1"), old: remote.head, new: head },
      ]);

      const refused = yield* packForPush({
        driveId: DRIVE,
        head,
        old: null,
        remoteHas: [remote.head],
        limits: { ...GITHUB_LIMITS, maxPushBytes: 1.5 * MiB },
      }).pipe(Effect.flip);
      expect(refused._tag).toBe("PushRefused");
      expect(refused.message).toContain("This push is 3 MB");
      expect(refused.message).toContain("GitHub takes pushes up to 2 MB");
      expect(refused.message).toContain("Nothing was pushed");
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
