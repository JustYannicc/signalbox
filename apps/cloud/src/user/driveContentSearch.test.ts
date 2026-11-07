import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectContentMatch,
  type ProjectSearchContentsInput,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_DRIVES_WS_METHODS, SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import { DriveReadError } from "../drive/DriveReader.ts";
import { threadRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import * as GitHub from "../github/GitHub.ts";
import * as GitHubConnection from "../github/GitHubConnection.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { driveRoot, remoteThreadWorktree } from "./contextProjects.ts";
import * as ContentSearchCursors from "./ContentSearchCursors.ts";
import * as DriveContentSearch from "./DriveContentSearch.ts";
import * as CloudRpc from "./rpc.ts";
import { UserDrives } from "./UserDrives.ts";

const ACME = SignalboxContextId.make("org_acme");
const PEOPLE = [
  { userId: "user_alice", email: "alice@acme.test", name: "Alice", organizations: [ACME] },
  { userId: "user_bob", email: "bob@acme.test", name: "Bob", organizations: [ACME] },
] as const;
const scopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
] as const;
const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});
type Cloud = ReturnType<typeof makeMemoryCloud>;
const connect = (
  cloud: Cloud,
  userId: string,
  granted: ReadonlyArray<AuthEnvironmentScope> = scopes,
) =>
  RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({
          identity: { environmentId: EnvironmentId.make("search-test"), label: "Cloud" },
          userId,
          sid: "search-session",
        }),
        CloudRpc.layerScopeAuthorization(granted),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud({ people: PEOPLE });
  for (const person of PEOPLE) {
    const user = cloud.userDirectory.forUser(person.userId);
    yield* user.recordSignIn({ id: person.userId, email: person.email, firstName: person.name });
    yield* user.syncOrganizations([{ id: ACME, name: "Acme" }]);
  }
  return {
    cloud,
    alice: yield* connect(cloud, "user_alice"),
    bob: yield* connect(cloud, "user_bob"),
  };
});
const publish = (
  cloud: Cloud,
  driveId: string,
  userId: string,
  git: ReturnType<typeof makeRepo>,
  head: string,
  threadId = `writer-${driveId.replaceAll("/", "-")}`,
  reconcile = true,
) =>
  Effect.gen(function* () {
    expect((yield* uploadPack({ driveId, threadId, ...git.pack([head]) }))._tag).toBe("ok");
    const drive = (yield* DriveDirectory).forDrive(driveId);
    const writer = { threadId, userId, generation: 1, live: true, packsAfter: 0 };
    const opened = yield* drive.open(writer);
    if (opened._tag !== "ok") return yield* Effect.die(opened);
    expect(
      (yield* drive.updateRefs(writer, [
        { name: threadRef(threadId), old: opened.refs.thread, new: head },
      ]))._tag,
    ).toBe("ok");
    if (reconcile)
      expect(
        (yield* drive.reconcile(writer, { expectedMain: opened.refs.main, newMain: head }))._tag,
      ).toBe("ok");
  }).pipe(Effect.provide(cloud.drives.layer));
const land = (cloud: Cloud, driveId: string, userId: string, contents: Record<string, string>) =>
  Effect.gen(function* () {
    const git = makeRepo();
    repos.push(git);
    for (const [path, text] of Object.entries(contents)) git.write(path, text);
    const head = git.commit("Search files");
    yield* publish(cloud, driveId, userId, git, head);
    return { git, head };
  });
const searchFor = (
  cloud: Cloud,
  userId: string,
  decorate: (files: DriveFiles["Service"]) => DriveFiles["Service"] = (files) => files,
) =>
  Effect.gen(function* () {
    const files = decorate(yield* DriveFiles);
    const drives = yield* UserDrives;
    const service = yield* DriveContentSearch.DriveContentSearch.pipe(
      Effect.provide(DriveContentSearch.layer),
      Effect.provideService(DriveFiles, files),
    );
    return (input: ProjectSearchContentsInput) =>
      Effect.flatMap(Effect.orDie(drives.contextIds), (contextIds) =>
        service.query({ userId, contextIds }, input),
      );
  }).pipe(Effect.provide(cloud.layerFor(userId)));
type Search = Effect.Success<ReturnType<typeof searchFor>>;
const input = (driveId: string, limit = 20): ProjectSearchContentsInput => ({
  cwd: driveRoot(driveId),
  query: "needle",
  limit,
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
});
const collect = (search: Search, request: ProjectSearchContentsInput) =>
  Effect.gen(function* () {
    const matches: ProjectContentMatch[] = [];
    let cursor = request.cursor;
    for (let page = 0; page < 20; page++) {
      const result = yield* search({ ...request, ...(cursor === undefined ? {} : { cursor }) });
      matches.push(...result.matches);
      if (result.nextCursor === undefined) return matches;
      cursor = result.nextCursor;
    }
    return yield* Effect.die("Search did not finish within twenty pages.");
  });

describe("cloud drive content search (#812)", () => {
  it.effect("denies removed source access before reading another snippet or snapshot", () =>
    Effect.gen(function* () {
      const { cloud, alice, bob } = yield* setup;
      const shared = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
        contextId: ACME,
        name: "Shared",
      });
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
        driveId: shared.id,
        email: PEOPLE[1].email,
        role: "viewer",
      });
      yield* land(cloud, shared.id, "user_alice", {
        "a.md": "needle first\n",
        "b.md": "needle private\n",
      });
      const reads: string[] = [];
      const search = yield* searchFor(cloud, "user_bob", (files) => ({
        ...files,
        contentSearchSnapshot: (...args) =>
          Effect.sync(() => reads.push("snapshot")).pipe(
            Effect.andThen(files.contentSearchSnapshot(...args)),
          ),
        searchContents: (...args) =>
          Effect.sync(() => reads.push("contents")).pipe(
            Effect.andThen(files.searchContents(...args)),
          ),
      }));
      const first = yield* search(input(shared.id, 1));
      expect(first.matches.map((match) => match.path)).toEqual(["a.md"]);
      expect(first.nextCursor).toBeDefined();
      if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
      const cachedEnd = yield* search({ ...input(shared.id, 1), cursor: first.nextCursor });
      expect(cachedEnd.matches.map((match) => match.path)).toEqual(["b.md"]);
      expect(cachedEnd.nextCursor).toBeUndefined();
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({ driveId: shared.id, userId: "user_bob" });
      const before = [...reads];
      for (const cursor of [undefined, first.nextCursor]) {
        expect(
          yield* search({
            ...input(shared.id, 1),
            ...(cursor === undefined ? {} : { cursor }),
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ContentSearchDenied",
          message: "You don't have access to this folder's files.",
        });
      }
      expect(reads).toEqual(before);
      const denied = yield* bob[WS_METHODS.projectsSearchContents](input(shared.id)).pipe(
        Effect.flip,
      );
      expect(denied).toMatchObject({
        _tag: "ProjectSearchContentsError",
        failure: "search_index_search_failed",
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "searches an accessible shortcut once and skips a revoked shortcut without reading it",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob } = yield* setup;
        const own = SignalboxDriveId.make("my/org_acme/user_bob");
        yield* land(cloud, own, "user_bob", { "own.md": "needle own\n" });
        const [shared, revoked] = yield* Effect.forEach(["Shared", "Revoked"], (name) =>
          Effect.gen(function* () {
            const target = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
              contextId: ACME,
              name,
            });
            yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
              driveId: target.id,
              email: PEOPLE[1].email,
              role: "viewer",
            });
            yield* land(cloud, target.id, "user_alice", { "spec.md": `needle ${name}\n` });
            return target;
          }),
        );
        if (shared === undefined || revoked === undefined)
          return yield* Effect.die("Missing shortcut fixtures.");
        for (const [path, target] of [
          ["a", shared.id],
          ["z", shared.id],
          ["locked", revoked.id],
        ] as const) {
          yield* bob[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({ driveId: own, path, target });
        }
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
          driveId: revoked.id,
          userId: "user_bob",
        });
        const reads: string[] = [];
        const search = yield* searchFor(cloud, "user_bob", (files) => ({
          ...files,
          searchContents: (driveId, ...args) =>
            Effect.sync(() => reads.push(driveId)).pipe(
              Effect.andThen(files.searchContents(driveId, ...args)),
            ),
        }));
        const matches = yield* collect(search, input(own));
        expect(matches.map((match) => match.path)).toEqual(["own.md", "a/spec.md"]);
        expect(reads).toEqual([own, shared.id]);
      }).pipe(Effect.scoped),
  );

  it.effect("discards snippets when membership is removed while the real scan runs", () =>
    Effect.gen(function* () {
      const { cloud, alice } = yield* setup;
      const shared = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
        contextId: ACME,
        name: "Shared",
      });
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
        driveId: shared.id,
        email: PEOPLE[1].email,
        role: "viewer",
      });
      yield* land(cloud, shared.id, "user_alice", { "secret.md": "needle secret\n" });
      const scanned: ProjectContentMatch[] = [];
      const search = yield* searchFor(cloud, "user_bob", (files) => ({
        ...files,
        searchContents: (...args) =>
          Effect.gen(function* () {
            const result = yield* files.searchContents(...args);
            scanned.push(...result.matches);
            yield* Effect.orDie(
              alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
                driveId: shared.id,
                userId: "user_bob",
              }),
            );
            return result;
          }),
      }));
      expect(yield* search(input(shared.id)).pipe(Effect.flip)).toMatchObject({
        _tag: "ContentSearchDenied",
        message: "You don't have access to this folder's files.",
      });
      expect(scanned.map((match) => match.lineContent)).toEqual(["needle secret"]);
    }).pipe(Effect.scoped),
  );

  it.effect("discards snippets when a shortcut is added while the source scan runs", () =>
    Effect.gen(function* () {
      const { cloud, alice } = yield* setup;
      const driveId = SignalboxDriveId.make("my/org_acme/user_alice");
      yield* land(cloud, driveId, "user_alice", { "secret.md": "needle original source\n" });
      const scanned: ProjectContentMatch[] = [];
      const search = yield* searchFor(cloud, "user_alice", (files) => ({
        ...files,
        searchContents: (...args) =>
          Effect.gen(function* () {
            const result = yield* files.searchContents(...args);
            scanned.push(...result.matches);
            yield* Effect.orDie(
              Effect.gen(function* () {
                const target = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
                  contextId: ACME,
                  name: "Added during search",
                });
                yield* alice[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
                  driveId,
                  path: "new-source",
                  target: target.id,
                });
              }),
            );
            return result;
          }),
      }));
      expect(yield* search(input(driveId)).pipe(Effect.flip)).toMatchObject({
        _tag: "ContentSearchReferencesChanged",
        message: "Folder references changed. Start a new search.",
      });
      expect(scanned.map((match) => match.lineContent)).toEqual(["needle original source"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "replays durable cursors against the original commit while a new search sees renames and deletions",
    () =>
      Effect.gen(function* () {
        const { cloud } = yield* setup;
        const driveId = "my/personal/user_alice";
        const { git } = yield* land(cloud, driveId, "user_alice", {
          "a.md": "needle a\n",
          "b.md": "needle b\n",
          "c.md": "needle c\n",
        });
        const request = input(driveId, 1);
        const search = yield* searchFor(cloud, "user_alice");
        const first = yield* search(request);
        expect(first.matches.map((match) => match.path)).toEqual(["a.md"]);
        expect(first.truncated).toBe(true);
        if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
        expect(first.nextCursor).not.toContain(driveId);
        git.git(["mv", "b.md", "renamed.md"]);
        git.git(["rm", "c.md"]);
        git.write("d.md", "needle d\n");
        yield* publish(cloud, driveId, "user_alice", git, git.commit("Rename, delete and add"));
        const resumed = yield* searchFor(cloud, "user_alice");
        const continuation = { ...request, cursor: first.nextCursor };
        const next = yield* resumed(continuation);
        const replay = yield* resumed(continuation);
        expect(replay).toEqual(next);
        expect(next.matches.map((match) => match.path)).toEqual(["b.md"]);
        expect((yield* collect(resumed, continuation)).map((match) => match.path)).toEqual([
          "b.md",
          "c.md",
        ]);
        expect((yield* collect(resumed, request)).map((match) => match.path)).toEqual([
          "a.md",
          "d.md",
          "renamed.md",
        ]);
        expect(
          yield* resumed({ ...continuation, query: "different" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ContentSearchExpired",
          message: "This search expired or changed. Start a new search.",
        });
        expect(
          yield* resumed({ ...request, cursor: "unknown-cursor" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ContentSearchExpired",
          message: "This search expired or changed. Start a new search.",
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "binds a queued shortcut cursor on first use so replay keeps the target's old commit",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob } = yield* setup;
        const own = SignalboxDriveId.make("my/org_acme/user_bob");
        yield* land(cloud, own, "user_bob", { "own.md": "No match here.\n" });
        const target = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Shared target",
        });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: target.id,
          email: PEOPLE[1].email,
          role: "viewer",
        });
        const { git } = yield* land(cloud, target.id, "user_alice", {
          "a.md": "needle old first\n",
          "b.md": "needle old second\n",
        });
        yield* bob[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
          driveId: own,
          path: "shared",
          target: target.id,
        });
        const request = input(own, 1);
        const search = yield* searchFor(cloud, "user_bob");
        const rootPage = yield* search(request);
        expect(rootPage.matches).toEqual([]);
        expect(rootPage.truncated).toBe(true);
        if (rootPage.nextCursor === undefined)
          return yield* Effect.die("Expected a queued source.");
        const queued = { ...request, cursor: rootPage.nextCursor };
        const firstTargetPage = yield* search(queued);
        expect(firstTargetPage.matches.map((match) => [match.path, match.lineContent])).toEqual([
          ["shared/a.md", "needle old first"],
        ]);
        expect(firstTargetPage.nextCursor).toBeDefined();

        git.git(["mv", "a.md", "renamed.md"]);
        git.git(["rm", "b.md"]);
        git.write("renamed.md", "needle changed\n");
        git.write("c.md", "needle new\n");
        yield* publish(cloud, target.id, "user_alice", git, git.commit("Change shortcut target"));
        const resumed = yield* searchFor(cloud, "user_bob");
        const replay = yield* resumed(queued);
        expect(replay).toEqual(firstTargetPage);
        expect(
          (yield* collect(resumed, queued)).map((match) => [match.path, match.lineContent]),
        ).toEqual([
          ["shared/a.md", "needle old first"],
          ["shared/b.md", "needle old second"],
        ]);
        expect(
          (yield* collect(resumed, request)).map((match) => [match.path, match.lineContent]),
        ).toEqual([
          ["shared/c.md", "needle new"],
          ["shared/renamed.md", "needle changed"],
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("replays a cold zero-match page after hydration and service recreation", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setup;
      const driveId = "my/personal/user_alice";
      yield* land(cloud, driveId, "user_alice", {
        "a.md": "needle first\n",
        "b.md": "needle second\n",
      });
      const request = input(driveId, 1);
      const first = yield* (yield* searchFor(cloud, "user_alice"))(request);
      if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
      const continuation = { ...request, cursor: first.nextCursor };
      let scans = 0;
      const cold = yield* searchFor(cloud, "user_alice", (files) => ({
        ...files,
        searchContents: (_drive, _input, _commit, state) =>
          Effect.sync(() => {
            scans++;
            return {
              matches: [],
              truncated: true,
              ...(state === undefined ? {} : { nextState: state }),
            };
          }),
      }));
      const page = yield* cold(continuation);
      expect(page.matches).toEqual([]);
      expect(page.truncated).toBe(true);
      expect(page.nextCursor).toBeDefined();
      const warm = yield* searchFor(cloud, "user_alice", (files) => ({
        ...files,
        searchContents: (...args) =>
          Effect.sync(() => scans++).pipe(Effect.andThen(files.searchContents(...args))),
      }));
      expect(yield* warm(continuation)).toEqual(page);
      expect(scans).toBe(1);
      if (page.nextCursor === undefined) return yield* Effect.die("Expected hydration progress.");
      const after = yield* warm({ ...request, cursor: page.nextCursor });
      expect(after.matches.map((match) => match.path)).toEqual(["b.md"]);
      expect(after.nextCursor).toBeUndefined();
      const restarted = yield* searchFor(cloud, "user_alice", (files) => ({
        ...files,
        searchContents: () => Effect.die("A persisted end page must not scan again."),
      }));
      expect(yield* restarted({ ...request, cursor: page.nextCursor })).toEqual(after);
    }).pipe(Effect.scoped),
  );

  it.effect("returns one canonical page and next token to concurrent scans", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setup;
      const driveId = "my/personal/user_alice";
      yield* land(cloud, driveId, "user_alice", {
        "a.md": "needle first\n",
        "b.md": "needle second\n",
        "c.md": "needle third\n",
      });
      const request = input(driveId, 1);
      const first = yield* (yield* searchFor(cloud, "user_alice"))(request);
      if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
      const bothScanning = yield* Deferred.make<void>();
      let scans = 0;
      const search = yield* searchFor(cloud, "user_alice", (files) => ({
        ...files,
        searchContents: (...args) =>
          Effect.gen(function* () {
            const scan = ++scans;
            if (scan === 2) yield* Deferred.succeed(bothScanning, undefined);
            yield* Deferred.await(bothScanning);
            const page = yield* files.searchContents(...args);
            return {
              ...page,
              matches: page.matches.map((match) => ({
                ...match,
                lineContent: `needle scan ${scan}`,
              })),
            };
          }),
      }));
      const continuation = { ...request, cursor: first.nextCursor };
      const pages = yield* Effect.all([search(continuation), search(continuation)], {
        concurrency: 2,
      });
      expect(scans).toBe(2);
      expect(pages[0].matches).toHaveLength(1);
      expect(pages[0].nextCursor).toBeDefined();
      expect(pages[0]).toEqual(pages[1]);
      const restarted = yield* searchFor(cloud, "user_alice");
      expect(yield* restarted(continuation)).toEqual(pages[0]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not replay an end page after source access or its shortcut route is removed",
    () =>
      Effect.gen(function* () {
        const { cloud, alice, bob } = yield* setup;
        const own = SignalboxDriveId.make("my/org_acme/user_bob");
        yield* land(cloud, own, "user_bob", { "own.md": "No match.\n" });
        const target = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
          contextId: ACME,
          name: "Target",
        });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: target.id,
          email: PEOPLE[1].email,
          role: "viewer",
        });
        yield* land(cloud, target.id, "user_alice", { "secret.md": "needle shared\n" });
        yield* bob[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
          driveId: own,
          path: "shared",
          target: target.id,
        });
        const request = input(own);
        const search = yield* searchFor(cloud, "user_bob");
        const first = yield* search(request);
        if (first.nextCursor === undefined) return yield* Effect.die("Expected a queued shortcut.");
        const continuation = { ...request, cursor: first.nextCursor };
        const page = yield* search(continuation);
        expect(page.matches.map((match) => match.path)).toEqual(["shared/secret.md"]);
        expect(page.nextCursor).toBeUndefined();
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
          driveId: target.id,
          userId: "user_bob",
        });
        expect(yield* search(continuation).pipe(Effect.flip)).toMatchObject({
          _tag: "ContentSearchDenied",
        });
        yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
          driveId: target.id,
          email: PEOPLE[1].email,
          role: "viewer",
        });
        expect(yield* search(continuation)).toEqual(page);
        yield* bob[SIGNALBOX_DRIVES_WS_METHODS.removeShortcut]({ driveId: own, path: "shared" });
        expect(yield* search(continuation).pipe(Effect.flip)).toMatchObject({
          _tag: "ContentSearchDenied",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("rechecks shortcut exclusions before replaying a cached end page", () =>
    Effect.gen(function* () {
      const { cloud, alice } = yield* setup;
      const own = SignalboxDriveId.make("my/org_acme/user_alice");
      const { git } = yield* land(cloud, own, "user_alice", {
        "a.md": "needle first\n",
        "b.md": "needle original source\n",
      });
      const request = input(own, 1);
      const search = yield* searchFor(cloud, "user_alice");
      const first = yield* search(request);
      if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
      const continuation = { ...request, cursor: first.nextCursor };
      expect((yield* search(continuation)).matches.map((match) => match.path)).toEqual(["b.md"]);
      const target = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
        contextId: ACME,
        name: "New source",
      });
      git.git(["rm", "b.md"]);
      yield* publish(cloud, own, "user_alice", git, git.commit("Replace the file with a shortcut"));
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
        driveId: own,
        path: "b.md",
        target: target.id,
      });
      expect(yield* search(continuation).pipe(Effect.flip)).toMatchObject({
        _tag: "ContentSearchReferencesChanged",
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects a cached end page when a locally packed source is rebound to another repository",
    () =>
      Effect.gen(function* () {
        const { cloud } = yield* setup;
        const driveId = "my/personal/user_alice";
        yield* land(cloud, driveId, "user_alice", {
          "a.md": "needle first\n",
          "b.md": "needle private old source\n",
        });
        yield* Effect.gen(function* () {
          const github = yield* GitHub.GitHub;
          const connection = yield* GitHubConnection.GitHubConnection;
          const directory = yield* DriveDirectory;
          const drives = yield* UserDrives;
          const checked: string[] = [];
          const service = yield* DriveContentSearch.DriveContentSearch.pipe(
            Effect.provide(DriveContentSearch.layer),
            Effect.provideService(GitHubConnection.GitHubConnection, {
              ...connection,
              accessToken: Effect.succeed("source-identity-test-token"),
            }),
            Effect.provideService(GitHub.GitHub, {
              ...github,
              api: {
                ...github.api,
                repository: (_token, repository) =>
                  Effect.sync(() => {
                    checked.push(repository);
                    return {
                      id: 1,
                      full_name: repository,
                      name: repository.split("/")[1]!,
                      default_branch: "main",
                      html_url: `https://github.test/${repository}`,
                      clone_url: `https://github.test/${repository}.git`,
                      ssh_url: `git@github.test:${repository}.git`,
                    };
                  }),
              },
            }),
          );
          const actor = { userId: "user_alice", contextIds: yield* drives.contextIds };
          const request = input(driveId, 1);
          const first = yield* service.query(actor, request);
          if (first.nextCursor === undefined) return yield* Effect.die("Expected a continuation.");
          const continuation = { ...request, cursor: first.nextCursor };
          const page = yield* service.query(actor, continuation);
          expect(page.matches.map((match) => match.lineContent)).toEqual([
            "needle private old source",
          ]);
          expect(page.nextCursor).toBeUndefined();
          yield* directory.forDrive(driveId).setRemote({
            provider: "github",
            repository: "acme/new-source",
            defaultBranch: "main",
          });
          expect(yield* service.query(actor, continuation).pipe(Effect.flip)).toMatchObject({
            _tag: "ContentSearchReferencesChanged",
          });
          expect(checked).toContain("acme/new-source");
        }).pipe(Effect.provide(cloud.layerFor("user_alice")));
      }).pipe(Effect.scoped),
  );

  it.effect("replays the exact page that skipped a revoked queued source", () =>
    Effect.gen(function* () {
      const { cloud, alice, bob } = yield* setup;
      const own = SignalboxDriveId.make("my/org_acme/user_bob");
      yield* land(cloud, own, "user_bob", { "own.md": "No match.\n" });
      const targets = yield* Effect.forEach(["a", "z"], (path) =>
        Effect.gen(function* () {
          const target = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
            contextId: ACME,
            name: path,
          });
          yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
            driveId: target.id,
            email: PEOPLE[1].email,
            role: "viewer",
          });
          yield* land(cloud, target.id, "user_alice", { "file.md": `needle ${path}\n` });
          yield* bob[SIGNALBOX_DRIVES_WS_METHODS.addShortcut]({
            driveId: own,
            path,
            target: target.id,
          });
          return target;
        }),
      );
      const request = input(own);
      const search = yield* searchFor(cloud, "user_bob");
      const first = yield* search(request);
      if (first.nextCursor === undefined || targets[0] === undefined)
        return yield* Effect.die("Expected queued source fixtures.");
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.unshare]({
        driveId: targets[0].id,
        userId: "user_bob",
      });
      const continuation = { ...request, cursor: first.nextCursor };
      const skipped = yield* search(continuation);
      expect(skipped.matches).toEqual([]);
      expect(skipped.nextCursor).toBeDefined();
      const restarted = yield* searchFor(cloud, "user_bob");
      expect(yield* restarted(continuation)).toEqual(skipped);
      expect((yield* collect(restarted, continuation)).map((match) => match.path)).toEqual([
        "z/file.md",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("expires persisted pages with their cursor and removes them on cleanup", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setup;
      const { cursors, sql } = yield* Effect.all({
        cursors: ContentSearchCursors.ContentSearchCursors,
        sql: SqlClient.SqlClient,
      }).pipe(
        Effect.provide(
          ContentSearchCursors.layerSql.pipe(Layer.provideMerge(cloud.layerFor("user_alice"))),
        ),
      );
      const state = {
        fingerprint: "legacy",
        root: "drive",
        sources: [],
        seen: [],
        truncated: false,
      };
      const token = yield* cursors.save(state);
      const page = { response: { matches: [], truncated: false }, skippedSource: false };
      expect(yield* cursors.commitPage(token, page)).toEqual(page);
      yield* sql`UPDATE drive_content_search_cursors SET expires_at = 0 WHERE token = ${token}`;
      expect(yield* cursors.readPage(token)).toBeNull();
      expect(yield* cursors.commitPage(token, page)).toBeNull();
      yield* cursors.save(state);
      expect(yield* sql`SELECT token FROM drive_content_search_pages`).toEqual([]);
      expect(yield* cursors.read(token)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps scanner failure causes through the service and RPC without exposing internal messages",
    () =>
      Effect.gen(function* () {
        const { cloud } = yield* setup;
        const driveId = "my/personal/user_alice";
        yield* land(cloud, driveId, "user_alice", { "file.md": "needle result\n" });
        const original = new DriveReadError({ message: "internal fixture" });
        const search = yield* searchFor(cloud, "user_alice", (files) => ({
          ...files,
          searchContents: () => Effect.fail(original),
        }));
        const failure = yield* search(input(driveId)).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ContentSearchFailed", stage: "scan" });
        if (failure._tag !== "ContentSearchFailed") return yield* Effect.die(failure);
        expect(failure.cause).toBe(original);
        expect(failure.message).toBe("The folder could not be searched. Try again.");

        const failures: Array<Effect.Error<ReturnType<Search>>> = [];
        const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              CloudRpc.layerHandlers({
                identity: { environmentId: EnvironmentId.make("search-test"), label: "Cloud" },
                userId: "user_alice",
                sid: "search-failure-session",
              }),
              CloudRpc.layerScopeAuthorization([AuthFilesystemReadScope]),
            ).pipe(
              Layer.provide(
                Layer.mergeAll(
                  cloud.layerFor("user_alice"),
                  Layer.succeed(DriveContentSearch.DriveContentSearch, {
                    query: (_actor, request) =>
                      search(request).pipe(
                        Effect.tapError((error) => Effect.sync(() => failures.push(error))),
                      ),
                  }),
                ),
              ),
            ),
          ),
        );
        const error = yield* rpc[WS_METHODS.projectsSearchContents](input(driveId)).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "ProjectSearchContentsError",
          detail: "The folder could not be searched. Try again.",
        });
        if (error._tag !== "ProjectSearchContentsError") return yield* Effect.die(error);
        expect(error.cause).toBe(failures[0]);
        expect(error.cause).toMatchObject({
          _tag: "ContentSearchFailed",
          stage: "scan",
          cause: original,
        });
        expect(error.message).not.toContain(original.message);
        expect(error.detail).not.toContain(original.message);
      }).pipe(Effect.scoped),
  );

  it.effect("authorizes a private thread before opening its file refs in a shared drive", () =>
    Effect.gen(function* () {
      const { cloud, alice } = yield* setup;
      const shared = yield* alice[SIGNALBOX_DRIVES_WS_METHODS.create]({
        contextId: ACME,
        name: "Shared",
      });
      yield* alice[SIGNALBOX_DRIVES_WS_METHODS.share]({
        driveId: shared.id,
        email: PEOPLE[1].email,
        role: "viewer",
      });
      const { git } = yield* land(cloud, shared.id, "user_alice", {
        "public.md": "ordinary files\n",
      });
      const threadId = ThreadId.make("private-search-thread");
      yield* alice[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch-private-search"),
        threadId,
        projectId: shared.projectId,
        title: "Private",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("private-search-message"),
          text: "Hi",
          attachments: [],
        },
      });
      git.write("private.md", "needle private branch\n");
      yield* publish(
        cloud,
        shared.id,
        "user_alice",
        git,
        git.commit("Private files"),
        threadId,
        false,
      );
      const reads: string[] = [];
      const bobSearch = yield* searchFor(cloud, "user_bob", (files) => ({
        ...files,
        contentSearchSnapshot: (...args) =>
          Effect.sync(() => reads.push("snapshot")).pipe(
            Effect.andThen(files.contentSearchSnapshot(...args)),
          ),
        searchContents: (...args) =>
          Effect.sync(() => reads.push("contents")).pipe(
            Effect.andThen(files.searchContents(...args)),
          ),
      }));
      const request = { ...input(shared.id), cwd: remoteThreadWorktree(shared.id, threadId).path };
      expect(yield* bobSearch(request).pipe(Effect.flip)).toMatchObject({
        _tag: "ContentSearchDenied",
      });
      expect(reads).toEqual([]);
      expect(yield* collect(bobSearch, input(shared.id))).toEqual([]);
      const aliceSearch = yield* searchFor(cloud, "user_alice");
      expect((yield* collect(aliceSearch, request)).map((match) => match.lineContent)).toEqual([
        "needle private branch",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("serves the existing content-search RPC only with filesystem read scope", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setup;
      const driveId = "my/personal/user_alice";
      yield* land(cloud, driveId, "user_alice", { "file.md": "needle result\n" });
      const denied = yield* connect(cloud, "user_alice", [AuthOrchestrationReadScope]);
      expect(
        yield* denied[WS_METHODS.projectsSearchContents](input(driveId)).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthFilesystemReadScope,
      });
      const allowed = yield* connect(cloud, "user_alice", [AuthFilesystemReadScope]);
      const result = yield* allowed[WS_METHODS.projectsSearchContents](input(driveId));
      expect(result.matches).toMatchObject([
        {
          path: "file.md",
          lineNumber: 1,
          lineContent: "needle result",
          matchRanges: [{ start: 0, end: 6 }],
        },
      ]);
      expect(result.truncated).toBe(false);
    }).pipe(Effect.scoped),
  );
});
