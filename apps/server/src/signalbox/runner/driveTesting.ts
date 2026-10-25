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

import {
  type CheckpointViews,
  type DriveCheckpointRecord,
  type DriveShortcut,
  type DriveState,
  type RefWriteResult,
  threadRemoteBranch,
} from "@signalbox/runner-protocol/DriveProtocol";
import { pullJson, type PullResult } from "@signalbox/runner-protocol/PullProtocol";
import * as Effect from "effect/Effect";

import { makeRunnerDrive } from "./RunnerDrive.ts";
import { DriveClientError, type DriveClient } from "./RunnerDriveClient.ts";
import type { SecretMask } from "./secretMask.ts";

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
    // Listing a real checkout's objects runs well past the default 1 MB.
    maxBuffer: 1024 * 1024 * 1024,
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
 * Uploads must be closed and not thin, but for files a remote head's folders
 * name, which the remote keeps (promised); refs move by CAS to commits it has;
 * `main` only fast-forwards to the thread's branch, from the main it merged.
 */
export const makeFakeDrive = (
  root: string,
  options: {
    readonly upstream?: string;
    readonly id?: string;
    /** False: a cloud from before machine state (#490), which answers no `machine` ref. */
    readonly machineState?: boolean;
  } = {},
) => {
  const id = options.id ?? "drive-1";
  const store = NodePath.join(root, options.id === undefined ? "store" : `store-${options.id}`);
  NodeFS.mkdirSync(store, { recursive: true });
  git(store, "init", "-q", "--bare");
  const packDir = NodePath.join(store, "objects", "pack");
  /** `owner`: the thread a private pack (its machine state) belongs to. */
  const packs: Array<{ seq: number; name: string; size: number; owner?: string }> = [];
  let main: string | null = null;
  const threads = new Map<
    string,
    {
      thread: string | null;
      wip: string | null;
      machine: string | null;
      base: string | null;
      notes: string | null;
      pinnedViews: CheckpointViews | null;
      revision: string | null;
    }
  >();
  const checkpointRecords = new Map<string, Array<DriveCheckpointRecord>>();
  const pullReceipts = new Map<string, { readonly request: string; readonly result: PullResult }>();
  const calls = { reconcile: 0, reconcileConflicts: 0, mirror: 0 };
  /** Set to make the cloud refuse every mirror, as when GitHub has not caught up yet. */
  const settings = {
    refuseMirror: false,
    failPullSaveOnce: false,
    failPullResponseAfterSaveOnce: false,
  };
  const shallow: Array<{ seq: number; oid: string }> = [];
  /** Files the remote keeps for the drive, as the cloud records them. */
  const promised = new Set<string>();
  /** What `oid` reaches that the store lacks. */
  const missingFrom = (oid: string) =>
    git(store, "rev-list", "--objects", "--missing=print", oid)
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
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
    /** Overrides the target's latest commit as a checkpoint-pinned version. */
    pinnedCommit?: string | null;
  }> = [];

  /** Like the cloud, lists only packs after the ones the machine says it has. */
  const state = (threadId: string | null, packsAfter: number): DriveState => {
    const { machine, ...refs } = (threadId === null ? undefined : threads.get(threadId)) ?? {
      thread: null,
      wip: null,
      machine: null,
      base: null,
      notes: null,
      pinnedViews: null,
      revision: null,
    };
    return {
      driveId: id,
      main,
      ...refs,
      ...(options.machineState === false ? {} : { machine }),
      notes: refs.notes ?? null,
      pinnedViews: refs.pinnedViews ?? null,
      revision: refs.revision ?? null,
      packs: packs
        .filter((pack) => pack.seq > packsAfter)
        .filter((pack) => pack.owner === undefined || pack.owner === threadId)
        .map(({ seq, name, size }) => ({ seq, name, size })),
      remote,
      shallow: shallow.filter((entry) => entry.seq > packsAfter).map((entry) => entry.oid),
    };
  };
  const has = (oid: string) => gitOk(store, "cat-file", "-e", `${oid}^{commit}`);
  /** The objects pack `name` holds. */
  const objectsOf = (name: string) =>
    git(store, "verify-pack", "-v", NodePath.join(packDir, `pack-${name}.idx`))
      .split("\n")
      .filter((line) => /^[0-9a-f]{40} /.test(line))
      .map((line) => line.slice(0, 40));

  const client = (threadId: string): DriveClient => {
    let packsAfter = 0;
    return {
      havePacksThrough: (seq) => {
        packsAfter = Math.max(packsAfter, seq);
      },
      open: Effect.sync(() => {
        if (!threads.has(threadId)) {
          threads.set(threadId, {
            thread: main,
            wip: null,
            machine: null,
            base: main,
            notes: null,
            pinnedViews: null,
            revision: null,
          });
        }
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
      recordCheckpoint: (record) =>
        Effect.sync((): RefWriteResult => {
          const refs = threads.get(threadId)!;
          if (!has(record.commit) || !has(record.notes)) {
            return { _tag: "refused", reason: "unknown checkpoint object" };
          }
          refs.notes = record.notes;
          const records = checkpointRecords.get(threadId) ?? [];
          if (!records.some((entry) => entry.runId === record.runId)) records.push(record);
          checkpointRecords.set(threadId, records);
          return { _tag: "ok", state: state(threadId, packsAfter) };
        }),
      savePull: ({ operation, result }) =>
        Effect.suspend(() => {
          if (settings.failPullSaveOnce) {
            settings.failPullSaveOnce = false;
            return Effect.fail(
              new DriveClientError({ message: "temporary pull receipt failure", retryable: true }),
            );
          }
          return Effect.sync(() => {
            const request = { operation, result };
            const encoded = pullJson.save.encode(request);
            const key = `${threadId}:${operation.id}`;
            const existing = pullReceipts.get(key);
            if (existing !== undefined) {
              return existing.request === encoded
                ? existing.result
                : ({
                    ...result,
                    outcome: "refused",
                    reason: "This pull operation id already names a different request.",
                  } satisfies PullResult);
            }
            const refs = threads.get(threadId);
            if (refs === undefined) {
              return {
                ...result,
                outcome: "refused",
                reason: "This thread has no drive branch.",
              } satisfies PullResult;
            }
            let saved: PullResult = result;
            if (operation.id !== result.id || operation.target !== result.target) {
              saved = {
                ...result,
                outcome: "refused",
                reason: "The pull result does not match its operation.",
              };
            } else if (
              refs.revision !== operation.revision ||
              refs.thread !== operation.expectedThread ||
              refs.wip !== operation.expectedWip
            ) {
              saved = {
                ...result,
                head: refs.thread,
                wip: refs.wip,
                outcome: "refused",
                reason: "The thread's saved work changed while pulling.",
              };
            } else if (
              (result.outcome === "pulled" && result.head !== operation.target) ||
              (result.outcome === "up_to_date" && result.head !== refs.thread) ||
              (result.outcome === "refused" &&
                (result.head !== refs.thread || result.wip !== refs.wip))
            ) {
              saved = {
                ...result,
                head: refs.thread,
                wip: refs.wip,
                outcome: "refused",
                reason: "The pull result does not match the selected target or current branch.",
              };
            } else if (result.outcome !== "refused") {
              const missing = [
                ...(result.outcome === "pulled" ? [operation.target] : []),
                result.head,
                result.wip,
              ].find((oid) => oid !== null && !has(oid));
              if (missing !== undefined) {
                saved = {
                  ...result,
                  head: refs.thread,
                  wip: refs.wip,
                  outcome: "refused",
                  reason: `The drive does not have commit ${missing}.`,
                };
              } else {
                refs.thread = result.head;
                refs.wip = result.wip;
              }
            }
            pullReceipts.set(key, { request: encoded, result: saved });
            return saved;
          }).pipe(
            Effect.flatMap((saved) => {
              if (!settings.failPullResponseAfterSaveOnce) return Effect.succeed(saved);
              settings.failPullResponseAfterSaveOnce = false;
              return Effect.fail(
                new DriveClientError({
                  message: "temporary pull response failure after receipt commit",
                  retryable: true,
                }),
              );
            }),
          );
        }),
      pullReceipt: (id) => Effect.sync(() => pullReceipts.get(`${threadId}:${id}`)?.result ?? null),
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
      uploadPack: (files, upload = {}) =>
        Effect.sync(() => {
          const idx = NodeFS.readFileSync(files.idx);
          const pack = NodeFS.readFileSync(files.pack);
          const name = Buffer.from(pack.subarray(pack.length - 20)).toString("hex");
          if (upload.remoteHead !== undefined && upload.remoteHead !== upstreamHead()) {
            throw new Error("not the remote's head");
          }
          const remoteCommits = [
            ...(upload.remoteHead === undefined ? [] : [upload.remoteHead]),
            ...(upload.remoteCommits ?? []),
          ];
          for (const oid of remoteCommits) {
            if (
              options.upstream === undefined ||
              !gitOk(options.upstream, "cat-file", "-e", `${oid}^{commit}`)
            ) {
              throw new Error(`${oid} is not on the remote`);
            }
          }
          NodeFS.writeFileSync(NodePath.join(packDir, `pack-${name}.pack`), pack);
          NodeFS.writeFileSync(NodePath.join(packDir, `pack-${name}.idx`), idx);
          for (const oid of remoteCommits) {
            // Parents the drive lacks stay on the remote, as the cloud records it.
            const parents = git(store, "cat-file", "-p", oid)
              .split("\n")
              .filter((line) => line.startsWith("parent "))
              .map((line) => line.slice("parent ".length));
            if (parents.some((parent) => !gitOk(store, "cat-file", "-e", parent))) {
              NodeFS.appendFileSync(NodePath.join(store, "shallow"), `${oid}\n`);
              shallow.push({ seq: packs.length + 1, oid });
            }
          }
          for (const oid of remoteCommits) {
            // And so do the files its folders name that the drive lacks.
            const files = new Set(
              git(store, "ls-tree", "-r", "--format=%(objectname)", oid).split("\n"),
            );
            for (const missing of missingFrom(oid)) if (files.has(missing)) promised.add(missing);
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
          for (const commit of commits) {
            const lacking = missingFrom(commit).filter((oid) => !promised.has(oid));
            if (lacking.length > 0) throw new Error(`not closed: ${lacking.join(", ")}`);
          }
          if (upload.private === true && options.machineState === false) {
            throw new Error("this cloud keeps no private packs");
          }
          packs.push({
            seq: packs.length + 1,
            name,
            size: pack.length,
            ...(upload.private === true ? { owner: threadId } : {}),
          });
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
                pinned: false,
              };
            }
            const target = shortcut.target.state(null, have[shortcut.target.id] ?? 0);
            return {
              path: shortcut.path,
              target: shortcut.target.id,
              readable: true,
              pinned: shortcut.pinnedCommit !== undefined,
              main: shortcut.pinnedCommit === undefined ? target.main : shortcut.pinnedCommit,
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
    checkpoints: (threadId: string) => checkpointRecords.get(threadId) ?? [],
    /** Every object in the packs `threadId` is handed. */
    objectsVisibleTo: (threadId: string) =>
      new Set(
        packs
          .filter((pack) => pack.owner === undefined || pack.owner === threadId)
          .flatMap((pack) => objectsOf(pack.name)),
      ),
    /** Moves a thread's ref behind its back, as a save that never landed would leave it. */
    forceRef: (threadId: string, ref: "thread" | "wip", oid: string | null) => {
      threads.get(threadId)![ref] = oid;
    },
    /** Applies the drive refs a restore would publish before a machine reopens the thread. */
    pinToCheckpoint: (threadId: string, commit: string, views: CheckpointViews) => {
      const refs = threads.get(threadId)!;
      refs.thread = commit;
      refs.wip = commit;
      refs.pinnedViews = views;
      refs.revision = `restore-${commit}`;
    },
    /** Objects in packs only `threadId` is handed. */
    privateObjectsOf: (threadId: string) =>
      packs.filter((pack) => pack.owner === threadId).flatMap((pack) => objectsOf(pack.name)),
    shallow: () => shallow.map((entry) => entry.oid),
    promised: () => [...promised],
    settings,
    mainFile: (file: string) => git(store, "show", `${main}:${file}`),
    onceBeforeReconcile: (effect: Effect.Effect<void>) => {
      beforeReconcile = effect;
    },
  };
  return drive;
};

export type FakeDrive = ReturnType<typeof makeFakeDrive>;

const makeRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-drive-"));

export const machine = (
  drive: FakeDrive,
  root: string,
  name: string,
  threadId: string,
  options: { readonly secretMask?: SecretMask } = {},
) =>
  makeRunnerDrive({
    cwd: NodePath.join(root, name, "threads", threadId),
    client: drive.client(threadId),
    branch: threadRemoteBranch(threadId),
    ...options,
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
