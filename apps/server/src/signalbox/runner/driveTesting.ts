// @effect-diagnostics nodeBuiltinImport:off - the fake drive and the assertions run real git on temp dirs.
/**
 * Drives for Runner tests: a fake of the cloud's drive API backed by real git
 * on temp dirs, machines checking it out, and the git helpers the assertions
 * use.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  DriveShortcut,
  DriveState,
  RefWriteResult,
} from "@signalbox/runner-protocol/DriveProtocol";
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

export const gitRaw = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
export const git = (cwd: string, ...args: Array<string>) => gitRaw(cwd, ...args).trim();
export const status = (cwd: string) =>
  gitRaw(cwd, "status", "--porcelain").split("\n").filter(Boolean);

export const gitOk = (cwd: string, ...args: Array<string>) => {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};

export const write = (cwd: string, file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, file), text);
};
export const read = (cwd: string, file: string) =>
  NodeFS.readFileSync(NodePath.join(cwd, file), "utf8");

/**
 * A drive the way the cloud keeps one: packs in a bare repository that holds
 * nothing else (so its connectivity is exactly the packs'), refs in memory.
 * Uploads must be closed and not thin; refs move by CAS to commits it has;
 * `main` only fast-forwards to the thread's branch, from the main it merged.
 */
export const makeFakeDrive = (
  root: string,
  options: { readonly upstream?: string; readonly id?: string } = {},
) => {
  const id = options.id ?? "drive-1";
  const store = NodePath.join(root, options.id === undefined ? "store" : `store-${options.id}`);
  NodeFS.mkdirSync(store, { recursive: true });
  git(store, "init", "-q", "--bare");
  const packDir = NodePath.join(store, "objects", "pack");
  const packs: Array<{ seq: number; name: string; size: number }> = [];
  let main: string | null = null;
  const threads = new Map<
    string,
    { thread: string | null; wip: string | null; base: string | null }
  >();
  const calls = { reconcile: 0, reconcileConflicts: 0, mirror: 0 };
  /** Set to make the cloud refuse every mirror, as when GitHub has not caught up yet. */
  const settings = { refuseMirror: false };
  const shallow: Array<{ seq: number; oid: string }> = [];
  const remote =
    options.upstream === undefined
      ? null
      : { provider: "github" as const, repository: "owner/repo", defaultBranch: "main" };
  /** What GitHub would say the remote's head is. */
  const upstreamHead = () =>
    options.upstream === undefined ? null : git(options.upstream, "rev-parse", "HEAD");
  let beforeReconcile: Effect.Effect<void> | null = null;
  /** Shortcuts of this drive (#142): other fake drives, and whether the thread's user can open them. */
  const shortcuts: Array<{
    path: string;
    target: FakeDrive;
    readable: boolean;
  }> = [];

  /** Like the cloud, lists only packs after the ones the machine says it has. */
  const state = (threadId: string | null, packsAfter: number): DriveState => {
    const refs = (threadId === null ? undefined : threads.get(threadId)) ?? {
      thread: null,
      wip: null,
      base: null,
    };
    return {
      driveId: id,
      main,
      ...refs,
      packs: packs.filter((pack) => pack.seq > packsAfter),
      remote,
      shallow: shallow.filter((entry) => entry.seq > packsAfter).map((entry) => entry.oid),
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
      state: Effect.sync(() => state(threadId, packsAfter)),
      remoteUrl: options.upstream === undefined ? "file:///nowhere" : `file://${options.upstream}`,
      mirror: (request) =>
        Effect.sync((): RefWriteResult => {
          calls.mirror++;
          if (remote === null || settings.refuseMirror) {
            return { _tag: "refused", reason: "not now" };
          }
          if (request.newMain !== upstreamHead())
            return { _tag: "refused", reason: "not the head" };
          if (!has(request.newMain)) return { _tag: "refused", reason: "unknown commit" };
          if (main !== request.newMain && main !== request.expectedMain) {
            return { _tag: "conflict", state: state(threadId, packsAfter) };
          }
          main = request.newMain;
          return { _tag: "ok", state: state(threadId, packsAfter) };
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
      uploadPack: (idx, pack, upload = {}) =>
        Effect.sync(() => {
          const name = Buffer.from(pack.subarray(pack.length - 20)).toString("hex");
          if (upload.remoteHead !== undefined && upload.remoteHead !== upstreamHead()) {
            throw new Error("not the remote's head");
          }
          NodeFS.writeFileSync(NodePath.join(packDir, `pack-${name}.pack`), pack);
          NodeFS.writeFileSync(NodePath.join(packDir, `pack-${name}.idx`), idx);
          if (upload.remoteHead !== undefined) {
            // Its parents stay on the remote, as the cloud records it.
            NodeFS.appendFileSync(NodePath.join(store, "shallow"), `${upload.remoteHead}\n`);
            shallow.push({ seq: packs.length + 1, oid: upload.remoteHead });
          }
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
      shortcuts: (have) =>
        Effect.sync(() =>
          shortcuts.map((shortcut): DriveShortcut => {
            if (!shortcut.readable) {
              return {
                path: shortcut.path,
                target: shortcut.target.id,
                readable: false,
                main: null,
                packs: [],
                shallow: [],
                remote: null,
              };
            }
            const target = shortcut.target.state(null, have[shortcut.target.id] ?? 0);
            return {
              path: shortcut.path,
              target: shortcut.target.id,
              readable: true,
              main: target.main,
              packs: target.packs,
              shallow: target.shallow,
              remote: target.remote,
            };
          }),
        ),
      downloadShortcutPack: (target, name, dir) =>
        Effect.sync(() => {
          const drive = shortcuts.find((shortcut) => shortcut.target.id === target)!.target;
          NodeFS.mkdirSync(dir, { recursive: true });
          for (const ext of ["pack", "idx"]) {
            NodeFS.copyFileSync(
              NodePath.join(drive.packDir, `pack-${name}.${ext}`),
              NodePath.join(dir, `pack-${name}.${ext}`),
            );
          }
        }),
      shortcutRemoteUrl: (target) => {
        const drive = shortcuts.find((shortcut) => shortcut.target.id === target)?.target;
        return drive?.upstream === undefined ? "file:///nowhere" : `file://${drive.upstream}`;
      },
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

  const drive = {
    id,
    upstream: options.upstream,
    state,
    shortcuts,
    store,
    packDir,
    packs,
    calls,
    client,
    refs: (threadId: string) => ({ main, ...threads.get(threadId)! }),
    shallow: () => shallow.map((entry) => entry.oid),
    settings,
    mainFile: (file: string) => git(store, "show", `${main}:${file}`),
    onceBeforeReconcile: (effect: Effect.Effect<void>) => {
      beforeReconcile = effect;
    },
  };
  return drive;
};

export type FakeDrive = ReturnType<typeof makeFakeDrive>;

export const makeRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-drive-"));

export const machine = (drive: FakeDrive, root: string, name: string, threadId: string) =>
  makeRunnerDrive({
    cwd: NodePath.join(root, name, "threads", threadId),
    client: drive.client(threadId),
  }).pipe(
    Effect.map((runner) => ({ runner, cwd: NodePath.join(root, name, "threads", threadId) })),
  );

export const scopedTest = <A, E>(body: (root: string) => Effect.Effect<A, E, never>) =>
  Effect.suspend(() => {
    const root = makeRoot();
    return body(root).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          // Shortcut mounts are read-only.
          NodeChildProcess.execFileSync("chmod", ["-R", "u+w", root]);
          NodeFS.rmSync(root, { recursive: true, force: true });
        }),
      ),
    );
  });
