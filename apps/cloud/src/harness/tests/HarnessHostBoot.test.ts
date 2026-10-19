import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { hostFixture, writeFixtureFile } from "./hostFixture.ts";

describe("Harness host durable boot", () => {
  it.effect.each(["valid", "invalid"] as const)(
    "keeps one accepted open snapshot while caller changes become %s during payload reads",
    (mutation) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const input = {
          bootAttemptId: "accepted-attempt",
          session: {
            ...instance.adapter.input.session,
            runtimePolicy: { ...instance.adapter.input.session.runtimePolicy },
          },
          checkpoint: {
            release: instance.host.release,
            providerSession: { ...instance.adapter.runtime.providerSession },
            snapshot: {
              providerThread: {
                ...instance.adapter.turn.providerThread,
                nativeThreadRef: {
                  driver: instance.adapter.runtime.driver,
                  nativeId: "native-thread",
                  strength: "strong" as const,
                },
              },
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            },
            revision: { commit: "accepted-revision" },
          },
        };
        const accepted = {
          ...input,
          session: { ...input.session, runtimePolicy: { ...input.session.runtimePolicy } },
          checkpoint: {
            ...input.checkpoint,
            providerSession: { ...input.checkpoint.providerSession },
            revision: { ...input.checkpoint.revision },
          },
        };
        const reading = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        f.setProgramReadGate(() => {
          reading.resolve();
          return resume.promise;
        });
        const opening = yield* instance.host.open(input).pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.addFinalizer(() => Effect.sync(() => resume.resolve()));
        yield* Effect.promise(() => reading.promise);
        input.bootAttemptId = "mutated-attempt";
        input.session.runtimePolicy.cwd = "/changed-workspace";
        input.checkpoint.revision.commit = "changed-revision";
        if (mutation === "invalid")
          Reflect.set(input.checkpoint.providerSession, "id", "wrong-session");
        resume.resolve();
        const exit = yield* Fiber.join(opening);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(f.acquisitions[0]?.session.runtimePolicy.cwd).toBe(
            accepted.session.runtimePolicy.cwd,
          );
          expect(f.acquisitions[0]?.checkpoint).toEqual(accepted.checkpoint);
          expect(yield* instance.host.open(accepted)).toBe(exit.value);
          const claims = f.handle.rows("SELECT * FROM harness_boot_attempts");
          expect(claims).toHaveLength(1);
          expect(claims[0]?.attempt_id).toBe(accepted.bootAttemptId);
          yield* exit.value.dispose;
        }
        f.setProgramReadGate(async () => {});
        const invalid = {
          ...accepted,
          bootAttemptId: "invalid-attempt",
          checkpoint: {
            ...accepted.checkpoint,
            providerSession: { ...accepted.checkpoint.providerSession },
          },
        };
        Reflect.set(invalid.checkpoint.providerSession, "id", "wrong-session");
        expect(Exit.isFailure(yield* instance.host.open(invalid).pipe(Effect.exit))).toBe(true);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reconstructs every owner between both stages and boot, then admits one acquisition",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const first = yield* f.make();
        yield* first.host.seed("assets");
        yield* first.host.dispose;
        f.reopen();
        f.mutateFiles((files) => writeFixtureFile(files, "/workspace/unrelated", "keep"));
        f.handle.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep')");
        const reads = f.loaderReads;
        const second = yield* f.make();
        expect(f.loaderReads).toBeGreaterThan(reads);
        yield* second.host.seed("programs");
        yield* second.host.dispose;
        f.reopen();
        const third = yield* f.make();
        const [a, b] = yield* Effect.all([third.open(), third.open()], { concurrency: 2 });
        expect(a).toBe(b);
        expect(f.acquisitions).toHaveLength(1);
        expect(f.persistenceBindings).toEqual([true]);
        expect(f.handle.rows("SELECT * FROM harness_seed_receipts")).toHaveLength(2);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
        expect(f.handle.rows("SELECT * FROM unrelated")).toEqual([{ value: "keep" }]);
        expect(f.handle.inode("/workspace/unrelated")).toBeTruthy();
        yield* a.dispose;
        yield* third.host.dispose;
        f.reopen();
        const fourth = yield* f.make();
        expect(Exit.isFailure(yield* fourth.open().pipe(Effect.exit))).toBe(true);
        const next = yield* fourth.open("new-explicit-owner-attempt");
        expect(f.acquisitions).toHaveLength(2);
        expect(f.computers[0]).not.toBe(f.computers[1]);
        yield* next.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect.each(["file", "metadata", "receipt"] as const)(
    "rolls back %s failure together with canonical files and retains earlier state",
    (failure) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const first = yield* f.make();
        yield* first.host.seed("assets");
        const before = f.handle.rows("SELECT * FROM kernel_fs_chunk ORDER BY ino,part");
        const receipts = f.handle.rows("SELECT * FROM harness_seed_receipts");
        f.handle.exec(
          "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserved')",
        );
        f.handle.failOnce((query) =>
          failure === "file"
            ? query.includes("INTO kernel_fs_chunk")
            : failure === "metadata"
              ? query.includes("UPDATE kernel_fs_posix SET mode")
              : query.includes("INSERT INTO harness_seed_receipts"),
        );
        expect(Exit.isFailure(yield* first.host.seed("programs").pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* first.open().pipe(Effect.exit))).toBe(true);
        yield* first.host.dispose;
        f.reopen();
        expect(f.handle.rows("SELECT * FROM kernel_fs_chunk ORDER BY ino,part")).toEqual(before);
        expect(f.handle.rows("SELECT * FROM harness_seed_receipts")).toEqual(receipts);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
        expect(f.handle.rows("SELECT * FROM unrelated")).toEqual([{ value: "preserved" }]);
        expect(() => f.handle.inode("/bin/bash")).toThrow();
        const recovered = yield* f.make();
        yield* recovered.host.seed("programs");
        const session = yield* recovered.open();
        expect(f.acquisitions).toHaveLength(1);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect.each(["receipt", "file", "bytes", "mode", "uid", "gid", "catalog", "symlink"] as const)(
    "rejects %s changes before the claim or native acquisition",
    (corruption) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const seeded = yield* f.make();
        yield* seeded.host.seed("assets");
        yield* seeded.host.seed("programs");
        yield* seeded.host.dispose;
        f.reopen();
        const inode = f.handle.inode("/bin/bash");
        if (corruption === "receipt")
          f.handle.exec("DELETE FROM harness_seed_receipts WHERE stage='programs'");
        if (corruption === "file") f.handle.exec("DELETE FROM kernel_fs_entry WHERE name='bash'");
        if (corruption === "bytes")
          f.handle.exec(
            `UPDATE kernel_fs_chunk SET bin=zeroblob(length(bin)) WHERE ino='${inode}'`,
          );
        if (corruption === "mode" || corruption === "uid" || corruption === "gid")
          f.handle.exec(
            `UPDATE kernel_fs_posix SET ${corruption}=${corruption}+1 WHERE ino='${inode}'`,
          );
        if (corruption === "catalog")
          f.handle.exec("UPDATE harness_seed_receipts SET catalog_id='changed'");
        if (corruption === "symlink")
          f.handle.exec(
            `UPDATE kernel_fs_inode SET type='symlink',target='/help' WHERE ino='${inode}'`,
          );
        const recovered = yield* f.make();
        expect(Exit.isFailure(yield* recovered.open().pipe(Effect.exit))).toBe(true);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
        expect(f.acquisitions).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses changed filesystem identity, release catalog, program metadata and unreceipted file adoption",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const seeded = yield* f.make();
        yield* seeded.host.seed("assets");
        yield* seeded.host.seed("programs");
        yield* seeded.host.dispose;
        f.reopen();
        expect(
          Exit.isFailure(
            yield* f
              .make({
                files: {
                  ...seeded.options.files,
                  database: f.handle.storage,
                  identity: "other-files",
                },
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        const release = yield* Effect.promise(() => f.codexRelease());
        const changedRelease = yield* f.make({ release });
        expect(Exit.isFailure(yield* changedRelease.open().pipe(Effect.exit))).toBe(true);
        yield* changedRelease.host.dispose;
        const changedPrograms = yield* f.make({
          programs: { ...seeded.options.programs, sourceIdentity: "other-catalog" },
        });
        expect(Exit.isFailure(yield* changedPrograms.open().pipe(Effect.exit))).toBe(true);
        yield* changedPrograms.host.dispose;
        f.handle.exec("DELETE FROM harness_seed_receipts WHERE stage='programs'");
        const missing = yield* f.make();
        expect(Exit.isFailure(yield* missing.host.seed("programs").pipe(Effect.exit))).toBe(true);
        expect(
          f.handle.rows("SELECT * FROM harness_seed_receipts WHERE stage='programs'"),
        ).toHaveLength(0);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "uses canonical catalog identity across descriptor property order and rejects new metadata",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const first = yield* f.make();
        yield* first.host.seed("assets");
        yield* first.host.seed("programs");
        yield* first.host.dispose;
        f.reopen();
        const files = Object.fromEntries(
          Object.entries(first.options.programs.files).map(([path, file]) => [
            path,
            {
              sha256: file.sha256,
              bytes: file.bytes,
              gid: file.gid,
              uid: file.uid,
              mode: file.mode,
            },
          ]),
        );
        const recovered = yield* f.make({ programs: { ...first.options.programs, files } });
        const session = yield* recovered.open();
        yield* session.dispose;
        yield* recovered.host.dispose;
        f.reopen();
        const changed = Object.fromEntries(
          Object.entries(files).map(([path, file]) => [path, { ...file, mode: 0o744 }]),
        );
        const invalid = yield* f.make({ programs: { ...first.options.programs, files: changed } });
        expect(Exit.isFailure(yield* invalid.open("changed-metadata").pipe(Effect.exit))).toBe(
          true,
        );
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("requires explicit empty stages for Codex and rejects programs before assets", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const release = yield* Effect.promise(() => f.codexRelease());
      const instance = yield* f.make({
        release,
        programs: {
          sourceIdentity: "empty",
          files: {},
          read: async () => {
            throw new Error("No program payload exists");
          },
        },
      });
      expect(Exit.isFailure(yield* instance.open().pipe(Effect.exit))).toBe(true);
      expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
      expect(Exit.isFailure(yield* instance.host.seed("programs").pipe(Effect.exit))).toBe(true);
      yield* instance.host.dispose;
      f.reopen();
      const recovered = yield* f.make({ release, programs: instance.options.programs });
      yield* recovered.host.seed("assets");
      yield* recovered.host.seed("programs");
      const session = yield* recovered.open();
      expect(f.handle.rows("SELECT * FROM harness_seed_receipts")).toHaveLength(2);
      yield* session.dispose;
    }).pipe(Effect.scoped),
  );
});
