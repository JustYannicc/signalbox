import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { handleFor } from "./DriveDirectory.ts";
import type { DrivePublicationRequest, DrivePublicationResult } from "./DrivePublicationTypes.ts";
import { DriveStore, layer, machineRef, threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo, registerPack } from "./driveTesting.ts";

const DRIVE = "my/personal/user_1";
const USER = "user_1";
const ID = "a9bf451b-8454-4a65-bca6-2a2b12e12d43";
const RETRY_ID = "0ef30623-6467-4e4a-a5b0-8e6c1eb6fcb4";
const request: DrivePublicationRequest = {
  operationId: ID,
  githubAccountId: 123,
  githubAccountLogin: "yannic",
  owner: "yannic",
  name: "project",
  visibility: "private",
  remoteName: "origin",
  protocol: "https",
  branch: "main",
};
const repository = {
  id: 456,
  fullName: "Yannic/Project",
  webUrl: "https://github.com/Yannic/Project",
  httpsUrl: "https://github.com/Yannic/Project.git",
  sshUrl: "git@github.com:Yannic/Project.git",
};
const publication = (result: DrivePublicationResult) => {
  expect(result._tag).toBe("ok");
  if (result._tag !== "ok") throw new Error(result.reason);
  return result.publication;
};
const created = (api: ReturnType<ReturnType<typeof makeMemoryDrives>["apiFor"]>) =>
  Effect.gen(function* () {
    const handle = handleFor(api);
    publication(yield* handle.beginPublication(USER, request));
    publication(yield* handle.markPublicationCreating(USER, ID));
    return publication(yield* handle.recordPublicationCreated(USER, { id: ID, repository }));
  });
const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const value = makeRepo();
  repos.push(value);
  return value;
};
afterEach(() => {
  for (const value of repos.splice(0)) value.cleanup();
});

describe("drive publication receipts", () => {
  it.effect("reserves exactly once for concurrent retries with newly proposed operation ids", () =>
    Effect.gen(function* () {
      const api = makeMemoryDrives().apiFor(DRIVE);
      const handle = handleFor(api);
      const results = yield* Effect.all(
        [
          handle.beginPublication(USER, request),
          handle.beginPublication(USER, { ...request, operationId: RETRY_ID }),
          handle.beginPublication(USER, { ...request, owner: " Yannic ", name: " PROJECT " }),
        ],
        { concurrency: "unbounded" },
      );
      const receipts = results.map(publication);
      expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1);
      expect(receipts[0]).toMatchObject({ phase: "reserved", repository: null, head: null });
      expect(receipts[1]).toEqual(receipts[0]);
      expect(receipts[2]).toEqual(receipts[0]);
      expect(yield* handle.remote()).toBeNull();
    }),
  );

  it.effect("rejects changed request identity once repository creation has started", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      publication(yield* handle.beginPublication(USER, request));
      const original = publication(yield* handle.markPublicationCreating(USER, ID));
      const changes: ReadonlyArray<Partial<DrivePublicationRequest>> = [
        { githubAccountId: 999 },
        { githubAccountLogin: "other" },
        { owner: "team" },
        { name: "other" },
        { visibility: "public" },
        { remoteName: "upstream" },
        { protocol: "ssh" },
      ];
      for (const change of changes) {
        expect(
          (yield* handle.beginPublication(USER, { ...request, ...change, operationId: RETRY_ID }))
            ._tag,
        ).toBe("refused");
      }
      expect(publication(yield* handle.beginPublication(USER, request))).toEqual(original);
    }),
  );

  it.effect("replaces a reserved request after preflight refusal and fences the abandoned id", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      publication(yield* handle.beginPublication(USER, request));
      expect((yield* handle.beginPublication(USER, { ...request, name: "available" }))._tag).toBe(
        "refused",
      );
      const replacementRequest = {
        ...request,
        operationId: RETRY_ID,
        owner: " Yannic ",
        name: " AVAILABLE ",
        visibility: "public",
        remoteName: "published",
        protocol: "ssh",
      } as const;
      const replacement = publication(yield* handle.beginPublication(USER, replacementRequest));
      expect(replacement).toMatchObject({
        id: RETRY_ID,
        phase: "reserved",
        head: null,
        repository: null,
        request: { ...replacementRequest, owner: "yannic", name: "available" },
      });
      expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      expect((yield* handle.bindPublication(USER, { id: ID, expectedMain: null }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.recordPublicationCreated(USER, { id: ID, repository }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.finishPublication(USER, ID))._tag).toBe("refused");
      expect(
        publication(
          yield* handle.beginPublication(USER, {
            ...replacementRequest,
            operationId: ID,
          }),
        ),
      ).toEqual(replacement);
      expect(publication(yield* handle.markPublicationCreating(USER, RETRY_ID)).phase).toBe(
        "creating",
      );
      expect((yield* handle.beginPublication(USER, request))._tag).toBe("refused");
      const recorded = publication(
        yield* handle.recordPublicationCreated(USER, {
          id: RETRY_ID,
          repository: { ...repository, fullName: "Yannic/Available" },
        }),
      );
      expect(recorded).toMatchObject({ id: RETRY_ID, phase: "created" });
    }),
  );

  it.effect("allows account switching while reserved and fences the former attempt", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      publication(yield* handle.beginPublication(USER, request));
      const switched = {
        ...request,
        operationId: RETRY_ID,
        githubAccountId: 999,
        githubAccountLogin: "other",
      };
      expect((yield* handle.beginPublication(USER, { ...switched, operationId: ID }))._tag).toBe(
        "refused",
      );
      const replacement = publication(yield* handle.beginPublication(USER, switched));
      expect(replacement).toMatchObject({
        id: RETRY_ID,
        userId: USER,
        phase: "reserved",
        request: switched,
      });
      expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      expect((yield* handle.bindPublication(USER, { id: ID, expectedMain: null }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.beginPublication(USER, request))._tag).toBe("refused");
      publication(yield* handle.markPublicationCreating(USER, RETRY_ID));
      expect(
        (yield* handle.beginPublication(USER, {
          ...request,
          operationId: "d8be7589-e303-4ca3-bc1f-8fa3e00e3150",
        }))._tag,
      ).toBe("refused");
    }),
  );

  it.effect("lets a current manager replace a revoked manager's reservation", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor("shared/personal/team"));
      const original = { userId: USER, email: "manager@example.com", name: null };
      const other = { userId: "other", email: "other@example.com", name: null };
      yield* handle.setup({
        name: "Team",
        members: [
          { ...original, role: "manager" },
          { ...other, role: "manager" },
        ],
      });
      publication(yield* handle.beginPublication(USER, request));
      yield* handle.share(other, original, "content_manager");
      expect(
        (yield* handle.beginPublication(USER, { ...request, operationId: RETRY_ID }))._tag,
      ).toBe("refused");
      expect((yield* handle.beginPublication("other", request))._tag).toBe("refused");
      const next = {
        ...request,
        operationId: RETRY_ID,
        githubAccountId: 999,
        githubAccountLogin: "other",
        name: "available",
      };
      const replacement = publication(yield* handle.beginPublication("other", next));
      expect(replacement).toMatchObject({
        id: RETRY_ID,
        userId: "other",
        phase: "reserved",
        request: next,
      });
      yield* handle.share(other, original, "manager");
      expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      expect((yield* handle.bindPublication(USER, { id: ID, expectedMain: null }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.beginPublication(USER, request))._tag).toBe("refused");
      expect(publication(yield* handle.markPublicationCreating("other", RETRY_ID)).phase).toBe(
        "creating",
      );
      expect(
        (yield* handle.beginPublication(USER, {
          ...request,
          operationId: "d8be7589-e303-4ca3-bc1f-8fa3e00e3150",
        }))._tag,
      ).toBe("refused");
    }),
  );

  it.effect("releases only the initiating current manager's sole unrecorded creation attempt", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor("shared/personal/team"));
      const original = { userId: USER, email: "manager@example.com", name: null };
      const other = { userId: "other", email: "other@example.com", name: null };
      yield* handle.setup({
        name: "Team",
        members: [
          { ...original, role: "manager" },
          { ...other, role: "manager" },
        ],
      });
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      const reserved = publication(yield* handle.beginPublication(USER, request));
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      publication(yield* handle.markPublicationCreating(USER, ID));
      expect((yield* handle.releasePublicationCreating(USER, RETRY_ID))._tag).toBe("refused");
      expect((yield* handle.releasePublicationCreating("other", ID))._tag).toBe("refused");
      yield* handle.share(other, original, "content_manager");
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      yield* handle.share(other, original, "manager");
      expect(publication(yield* handle.releasePublicationCreating(USER, ID))).toEqual(reserved);
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      // A new request has its own first attempt; the abandoned id stays fenced.
      publication(
        yield* handle.beginPublication(USER, {
          ...request,
          operationId: RETRY_ID,
          name: "available",
        }),
      );
      expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      publication(yield* handle.markPublicationCreating(USER, RETRY_ID));
      expect(publication(yield* handle.releasePublicationCreating(USER, RETRY_ID)).phase).toBe(
        "reserved",
      );
    }),
  );

  it.effect("never releases after concurrent or prior additional creation claims", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      publication(yield* handle.beginPublication(USER, request));
      const claims = yield* Effect.all(
        [handle.markPublicationCreating(USER, ID), handle.markPublicationCreating(USER, ID)],
        { concurrency: "unbounded" },
      );
      expect(claims.map(publication).map((receipt) => receipt.phase)).toEqual([
        "creating",
        "creating",
      ]);
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      expect(
        (yield* handle.beginPublication(USER, {
          ...request,
          operationId: RETRY_ID,
          name: "available",
        }))._tag,
      ).toBe("refused");
      expect(
        publication(yield* handle.recordPublicationCreated(USER, { id: ID, repository })).phase,
      ).toBe("created");
    }),
  );

  it.effect(
    "releases consecutive definitive failures on the same receipt before changing requests",
    () =>
      Effect.gen(function* () {
        const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
        const reserved = publication(yield* handle.beginPublication(USER, request));
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(publication(yield* handle.beginPublication(USER, request))).toEqual(reserved);
          expect(publication(yield* handle.markPublicationCreating(USER, ID)).phase).toBe(
            "creating",
          );
          expect(publication(yield* handle.releasePublicationCreating(USER, ID))).toEqual(reserved);
        }
        const changed = publication(
          yield* handle.beginPublication(USER, {
            ...request,
            operationId: RETRY_ID,
            name: "available",
          }),
        );
        expect(changed).toMatchObject({
          id: RETRY_ID,
          phase: "reserved",
          request: { name: "available" },
        });
        expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      }),
  );

  it.effect("a concurrent new claim prevents renaming even if release wins the race", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      publication(yield* handle.beginPublication(USER, request));
      publication(yield* handle.markPublicationCreating(USER, ID));
      const [, claiming] = yield* Effect.all(
        [handle.releasePublicationCreating(USER, ID), handle.markPublicationCreating(USER, ID)],
        { concurrency: "unbounded" },
      );
      expect(publication(claiming).phase).toBe("creating");
      expect(publication(yield* handle.beginPublication(USER, request)).phase).toBe("creating");
      expect(
        (yield* handle.beginPublication(USER, {
          ...request,
          operationId: RETRY_ID,
          name: "available",
        }))._tag,
      ).toBe("refused");
    }),
  );

  it.effect(
    "migrates legacy creating receipts as unknown attempts and reserved receipts as unstarted",
    () =>
      Effect.gen(function* () {
        for (const initialPhase of ["reserved", "creating"] as const) {
          yield* Effect.gen(function* () {
            const s = yield* DriveStore;
            const sql = yield* SqlClient.SqlClient;
            yield* s.initialize;
            publication(yield* s.beginPublication(USER, request));
            if (initialPhase === "creating")
              publication(yield* s.markPublicationCreating(USER, ID));
            yield* sql`ALTER TABLE drive_repository_publication DROP COLUMN creation_attempts`;
            yield* sql`DROP TABLE drive_publication_ids`;
            yield* sql`DELETE FROM effect_sql_migrations
            WHERE migration_id = 11 AND name = 'drive_publication_creation_attempts'`;
            yield* s.initialize;
            expect(publication(yield* s.beginPublication(USER, request)).phase).toBe(initialPhase);
            const [attempts] = yield* sql<{ readonly creation_attempts: number | null }>`
            SELECT creation_attempts FROM drive_repository_publication WHERE singleton = 1`;
            expect(attempts?.creation_attempts).toBe(initialPhase === "reserved" ? 0 : null);
            publication(yield* s.markPublicationCreating(USER, ID));
            const released = yield* s.releasePublicationCreating(USER, ID);
            if (initialPhase === "reserved") expect(publication(released).phase).toBe("reserved");
            else {
              expect(released._tag).toBe("refused");
              expect(
                publication(yield* s.recordPublicationCreated(USER, { id: ID, repository })).phase,
              ).toBe("created");
            }
          }).pipe(
            Effect.provide(
              layer(DRIVE).pipe(
                Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
              ),
            ),
          );
        }
      }),
  );

  it.effect("serializes replacement against creation so only one attempt can proceed", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      publication(yield* handle.beginPublication(USER, request));
      const replacementRequest = { ...request, operationId: RETRY_ID, name: "available" };
      const [replacement, starting] = yield* Effect.all(
        [
          handle.beginPublication(USER, replacementRequest),
          handle.markPublicationCreating(USER, ID),
        ],
        { concurrency: "unbounded" },
      );
      expect([replacement, starting].filter((result) => result._tag === "ok")).toHaveLength(1);
      if (replacement._tag === "ok") {
        expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
        expect(publication(yield* handle.beginPublication(USER, replacementRequest))).toEqual(
          replacement.publication,
        );
      } else {
        expect(publication(starting)).toMatchObject({ id: ID, phase: "creating" });
        expect((yield* handle.beginPublication(USER, replacementRequest))._tag).toBe("refused");
      }
    }),
  );

  it.effect("requires each phase and completes an empty history with replay", () =>
    Effect.gen(function* () {
      const handle = handleFor(makeMemoryDrives().apiFor(DRIVE));
      expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      publication(yield* handle.beginPublication(USER, request));
      expect((yield* handle.recordPublicationCreated(USER, { id: ID, repository }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.bindPublication(USER, { id: ID, expectedMain: null }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.finishPublication(USER, ID))._tag).toBe("refused");
      expect(publication(yield* handle.markPublicationCreating(USER, ID)).phase).toBe("creating");
      expect(publication(yield* handle.markPublicationCreating(USER, ID)).phase).toBe("creating");
      expect(
        (yield* handle.recordPublicationCreated(USER, {
          id: ID,
          repository: { ...repository, fullName: "other/repo" },
        }))._tag,
      ).toBe("refused");
      const recorded = publication(
        yield* handle.recordPublicationCreated(USER, { id: ID, repository }),
      );
      expect(recorded.phase).toBe("created");
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      expect(
        (yield* handle.beginPublication(USER, { ...request, operationId: RETRY_ID, name: "other" }))
          ._tag,
      ).toBe("refused");
      expect(
        publication(yield* handle.recordPublicationCreated(USER, { id: ID, repository })),
      ).toEqual(recorded);
      expect(
        (yield* handle.recordPublicationCreated(USER, {
          id: ID,
          repository: { ...repository, id: 999 },
        }))._tag,
      ).toBe("refused");
      expect((yield* handle.finishPublication(USER, ID))._tag).toBe("refused");
      const bound = publication(
        yield* handle.bindPublication(USER, { id: ID, expectedMain: null }),
      );
      expect(bound).toMatchObject({ phase: "bound", head: null, repository });
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      expect(
        (yield* handle.beginPublication(USER, { ...request, operationId: RETRY_ID, name: "other" }))
          ._tag,
      ).toBe("refused");
      expect(
        publication(yield* handle.recordPublicationCreated(USER, { id: ID, repository })),
      ).toEqual(bound);
      const complete = publication(yield* handle.finishPublication(USER, ID));
      expect(complete.phase).toBe("complete");
      expect((yield* handle.releasePublicationCreating(USER, ID))._tag).toBe("refused");
      expect(
        (yield* handle.beginPublication(USER, { ...request, operationId: RETRY_ID, name: "other" }))
          ._tag,
      ).toBe("refused");
      expect(
        publication(yield* handle.beginPublication(USER, { ...request, operationId: RETRY_ID })),
      ).toEqual(complete);
      expect(publication(yield* handle.markPublicationCreating(USER, ID))).toEqual(complete);
      expect(
        publication(yield* handle.recordPublicationCreated(USER, { id: ID, repository })),
      ).toEqual(complete);
      expect(
        publication(yield* handle.bindPublication(USER, { id: ID, expectedMain: "newer-head" })),
      ).toEqual(complete);
      expect(publication(yield* handle.finishPublication(USER, ID))).toEqual(complete);
    }),
  );

  it.effect(
    "rejects an existing remote without a receipt and never overwrites an unrelated remote",
    () =>
      Effect.gen(function* () {
        const drives = makeMemoryDrives();
        const api = drives.apiFor(DRIVE);
        const handle = handleFor(api);
        const remote = {
          provider: "github",
          repository: "elsewhere/repo",
          defaultBranch: "main",
        } as const;
        yield* handle.setRemote(remote);
        expect((yield* handle.beginPublication(USER, request))._tag).toBe("refused");
        const next = handleFor(drives.apiFor("my/company/user_1"));
        yield* created(drives.apiFor("my/company/user_1"));
        yield* next.setRemote(remote);
        expect((yield* next.bindPublication(USER, { id: ID, expectedMain: null }))._tag).toBe(
          "refused",
        );
        expect(yield* next.remote()).toEqual(remote);
        expect((yield* next.beginPublication(USER, request))._tag).toBe("refused");
      }),
  );

  it.effect("checks current manager access and initiating user on every operation", () =>
    Effect.gen(function* () {
      const api = makeMemoryDrives().apiFor("shared/personal/team");
      const handle = handleFor(api);
      const manager = { userId: USER, email: "manager@example.com", name: null };
      const other = { userId: "other", email: "other@example.com", name: null };
      yield* handle.setup({
        name: "Team",
        members: [
          { ...manager, role: "manager" },
          { ...other, role: "manager" },
        ],
      });
      yield* created(api);
      expect((yield* handle.beginPublication(other.userId, request))._tag).toBe("refused");
      expect((yield* handle.markPublicationCreating(other.userId, ID))._tag).toBe("refused");
      expect(
        (yield* handle.recordPublicationCreated(other.userId, { id: ID, repository }))._tag,
      ).toBe("refused");
      expect(
        (yield* handle.bindPublication(other.userId, { id: ID, expectedMain: null }))._tag,
      ).toBe("refused");
      expect((yield* handle.finishPublication(other.userId, ID))._tag).toBe("refused");
      publication(yield* handle.bindPublication(USER, { id: ID, expectedMain: null }));
      yield* handle.share(other, manager, "content_manager");
      expect((yield* handle.beginPublication(USER, request))._tag).toBe("refused");
      expect((yield* handle.markPublicationCreating(USER, ID))._tag).toBe("refused");
      expect((yield* handle.recordPublicationCreated(USER, { id: ID, repository }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.bindPublication(USER, { id: ID, expectedMain: null }))._tag).toBe(
        "refused",
      );
      expect((yield* handle.finishPublication(USER, ID))._tag).toBe("refused");
      yield* handle.unshare(other, USER);
      expect((yield* handle.finishPublication(USER, ID))._tag).toBe("refused");
      yield* handle.share(other, manager, "manager");
      expect(publication(yield* handle.finishPublication(USER, ID)).phase).toBe("complete");
    }),
  );

  it.effect("reopens durable receipts after every phase without changing their identity", () =>
    Effect.gen(function* () {
      const filename = `${repo().dir}/drive.sqlite`;
      const persisted = layer(DRIVE).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
      const steps = [
        (s: DriveStore["Service"]) => s.beginPublication(USER, request),
        (s: DriveStore["Service"]) => s.markPublicationCreating(USER, ID),
        (s: DriveStore["Service"]) => s.recordPublicationCreated(USER, { id: ID, repository }),
        (s: DriveStore["Service"]) => s.bindPublication(USER, { id: ID, expectedMain: null }),
        (s: DriveStore["Service"]) => s.finishPublication(USER, ID),
      ];
      for (const step of steps) {
        const after = publication(
          yield* Effect.scoped(
            DriveStore.use((s) => s.initialize.pipe(Effect.andThen(step(s)))).pipe(
              Effect.provide(persisted),
            ),
          ),
        );
        const replay = publication(
          yield* Effect.scoped(
            DriveStore.use((s) =>
              s.initialize.pipe(
                Effect.andThen(s.beginPublication(USER, { ...request, operationId: RETRY_ID })),
              ),
            ).pipe(Effect.provide(persisted)),
          ),
        );
        expect(replay).toEqual(after);
      }
    }),
  );

  it.effect("CAS binds fresh main, preserves refs and packs, then keeps its frozen head", () =>
    Effect.gen(function* () {
      const s = yield* DriveStore;
      yield* s.initialize;
      const git = repo();
      const first = git.commit("first");
      const second = git.commit("second");
      const third = git.commit("third");
      yield* registerPack("thread-1", git.pack([third]));
      publication(yield* s.beginPublication(USER, request));
      publication(yield* s.markPublicationCreating(USER, ID));
      publication(yield* s.recordPublicationCreated(USER, { id: ID, repository }));
      yield* s.replaceMain(USER, { expectedMain: null, newMain: first });
      const writer = {
        userId: USER,
        threadId: "thread-1",
        generation: 1,
        live: true,
        packsAfter: 0,
      };
      yield* s.open(writer);
      yield* s.updateRefs(writer, [
        { name: threadRef(writer.threadId), old: first, new: third },
        { name: wipRef(writer.threadId), old: null, new: second },
        { name: machineRef(writer.threadId), old: null, new: third },
      ]);
      yield* s.replaceMain(USER, { expectedMain: first, newMain: second });
      const before = yield* s.refs(writer.threadId);
      expect((yield* s.bindPublication(USER, { id: ID, expectedMain: first }))._tag).toBe(
        "refused",
      );
      expect(yield* s.remote).toBeNull();
      expect(publication(yield* s.beginPublication(USER, request)).phase).toBe("created");
      const bound = publication(yield* s.bindPublication(USER, { id: ID, expectedMain: second }));
      expect(bound.head).toBe(second);
      const remote = { provider: "github", repository: repository.fullName, defaultBranch: "main" };
      expect(yield* s.refs(writer.threadId)).toEqual({ ...before, remote });
      expect((yield* s.locate([first, second, third])).length).toBe(3);
      yield* s.replaceMain(USER, { expectedMain: second, newMain: third });
      expect(publication(yield* s.bindPublication(USER, { id: ID, expectedMain: third }))).toEqual(
        bound,
      );
      expect(publication(yield* s.finishPublication(USER, ID)).head).toBe(second);
    }).pipe(
      Effect.provide(
        layer(DRIVE).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );

  it.effect("rolls back the remote if persisting the bound receipt fails", () =>
    Effect.gen(function* () {
      const s = yield* DriveStore;
      const sql = yield* SqlClient.SqlClient;
      yield* s.initialize;
      publication(yield* s.beginPublication(USER, request));
      publication(yield* s.markPublicationCreating(USER, ID));
      publication(yield* s.recordPublicationCreated(USER, { id: ID, repository }));
      yield* sql`CREATE TRIGGER fail_publication_update BEFORE UPDATE ON drive_repository_publication
        BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`;
      const result = yield* Effect.exit(s.bindPublication(USER, { id: ID, expectedMain: null }));
      expect(result._tag).toBe("Failure");
      expect(yield* s.remote).toBeNull();
      expect(publication(yield* s.beginPublication(USER, request)).phase).toBe("created");
      yield* sql`DROP TRIGGER fail_publication_update`;
      expect(
        publication(yield* s.bindPublication(USER, { id: ID, expectedMain: null })).phase,
      ).toBe("bound");
    }).pipe(
      Effect.provide(
        layer(DRIVE).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );
});
