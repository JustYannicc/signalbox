// @effect-diagnostics nodeBuiltinImport:off - tests build real git repositories to pack.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as UserDirectory from "../user/UserDirectory.ts";
import { deliverAccess } from "./driveAccessOutbox.ts";
import type * as DriveEvents from "./DriveEvents.ts";
import { deliverDriveEvents } from "./driveEventOutbox.ts";
import * as DriveDirectory from "./DriveDirectory.ts";
import { makeDriveObjectApi } from "./driveObjectApi.ts";
import * as DrivePacks from "./DrivePacks.ts";
import type * as DriveMembers from "./DriveMembers.ts";
import * as DriveStore from "./DriveStore.ts";
import { parseCommit, type Bytes } from "./git/gitObjects.ts";
import { verifyPack } from "./git/gitPack.ts";
export { concatBytes } from "./git/gitObjects.ts";

/**
 * Test wiring for drives: drive objects on in-memory SQLite, packs in memory,
 * real git to make packs. With `users`, membership changes and ref moves
 * reach people's objects right away, as the drive object's alarm would
 * deliver them.
 */
export const makeMemoryDrives = (
  options: { readonly users?: () => UserDirectory.UserDirectory["Service"] } = {},
) => {
  const objects = new Map<string, DriveDirectory.DriveObjectApi>();
  const bucket = DrivePacks.makeMemoryBucket();
  const apiFor = (driveId: string) => {
    const existing = objects.get(driveId);
    if (existing !== undefined) return existing;
    const runtime = ManagedRuntime.make(
      DriveStore.layer(driveId).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    );
    let ready: Promise<void> | undefined;
    const run = async <A, E>(
      effect: Effect.Effect<
        A,
        E,
        DriveStore.DriveStore | DriveMembers.DriveMembers | DriveEvents.DriveEvents
      >,
    ) => {
      ready ??= runtime.runPromise(DriveStore.DriveStore.use((store) => store.initialize));
      await ready;
      return runtime.runPromise(effect);
    };
    const api = makeDriveObjectApi(run, async () => {
      const users = options.users;
      if (users === undefined) return;
      await run(
        Effect.all([deliverAccess(driveId), deliverDriveEvents(driveId)]).pipe(
          Effect.provideService(UserDirectory.UserDirectory, users()),
        ),
      );
    });
    objects.set(driveId, api);
    return api;
  };
  const layer = Layer.mergeAll(
    Layer.succeed(
      DriveDirectory.DriveDirectory,
      DriveDirectory.DriveDirectory.of({
        forDrive: (driveId) => DriveDirectory.handleFor(apiFor(driveId)),
      }),
    ),
    DrivePacks.layerBucket(bucket),
  );
  return { apiFor, bucket, layer };
};

/** A git repository in a temp dir, with an isolated config. */
export const makeRepo = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drive-test-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (args: ReadonlyArray<string>, input?: string) =>
    NodeChildProcess.execFileSync("git", args, { cwd: dir, env, input, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "work"]);
  const write = (path: string, contents: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, path), contents);
  };
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-q", "--allow-empty", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  /** A pack of what `include` reaches and `exclude` does not, as the Runner builds one. */
  const pack = (
    include: ReadonlyArray<string>,
    exclude: ReadonlyArray<string> = [],
    filter?: string,
  ) => {
    const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drive-pack-"));
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
    return { name, pack: read("pack"), idx: read("idx") };
  };
  const cleanup = () => NodeFS.rmSync(dir, { recursive: true, force: true });
  return { dir, git, write, commit, pack, cleanup };
};

export const registerPack = (
  threadId: string,
  packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>,
) =>
  Effect.gen(function* () {
    const verified = yield* Effect.promise(() => verifyPack(packed.pack, packed.idx));
    const commits = [...verified.structure].flatMap(([oid, object]) => {
      if (object.type !== "commit") return [];
      const commit = parseCommit(object.content);
      return [
        {
          oid,
          tree: commit.tree,
          parents: commit.parents,
          authorName: commit.author.name,
          authorEmail: commit.author.email,
          time: commit.author.time,
          message: commit.message,
        },
      ];
    });
    return yield* DriveStore.DriveStore.use((store) =>
      store.registerPack({
        name: verified.name,
        size: packed.pack.length,
        threadId,
        objects: verified.objects,
        commits,
        external: [...verified.external],
      }),
    );
  });
