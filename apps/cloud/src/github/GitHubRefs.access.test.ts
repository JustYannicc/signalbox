import { describe, expect, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { projectIdForDrive } from "../user/contextProjects.ts";
import { actor, current, fixture, root } from "./githubRefsTesting.ts";

const assertError = Schema.decodeUnknownSync(GitCommandError);

describe("cloud ref access", () => {
  it.effect("validates the thread's recorded working tree before returning refs", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      state.threadPath = `${root}/threads/other`;
      const elsewhere = assertError(
        yield* listRefs(actor, { cwd: current.path }).pipe(Effect.flip),
      );
      expect(elsewhere.detail).toContain("no working tree here");
      state.threadPath = current.path;
      state.threadBranch = null;
      const missing = assertError(yield* listRefs(actor, { cwd: current.path }).pipe(Effect.flip));
      expect(missing.detail).toContain("no working tree here");
      expect(state.requests).toHaveLength(0);
      expect(state.remoteReads).toBe(0);
    }),
  );
  it.effect("rechecks folder grants before any read on each page", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      const first = yield* listRefs(actor, { cwd: current.path, limit: 1 });
      state.role = null;
      const error = assertError(
        yield* listRefs(actor, { cwd: current.path, cursor: first.nextCursor! }).pipe(Effect.flip),
      );
      expect(error.detail).toContain("can't open this drive");
      expect(state.folderChecks).toBe(2);
      expect(state.threadChecks).toBe(1);
      expect(state.remoteReads).toBe(1);
      expect(state.requests).toHaveLength(2);
    }),
  );

  it.effect("rechecks repository permission even for local-only reads", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      yield* listRefs(actor, { cwd: current.path, refKind: "local" });
      state.repositoryStatus = 404;
      const error = assertError(
        yield* listRefs(actor, { cwd: current.path, refKind: "local" }).pipe(Effect.flip),
      );
      expect(error).toMatchObject({ operation: "vcs.listRefs", cwd: current.path });
      expect(error.detail).toContain("can't open this repository");
      expect(state.requests).toHaveLength(3);
    }),
  );

  it.effect("rechecks private-thread access on later pages", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      yield* listRefs(actor, { cwd: current.path, limit: 1 });
      state.threadVisible = false;
      const error = assertError(
        yield* listRefs(actor, { cwd: current.path, cursor: 1 }).pipe(Effect.flip),
      );
      expect(error.detail).toContain("thread is unavailable");
      expect(state.threadChecks).toBe(2);
      expect(state.requests).toHaveLength(2);
    }),
  );

  it.effect(
    "rejects nonexistent threads and threads from a different folder before GitHub reads",
    () =>
      Effect.gen(function* () {
        const { listRefs, state } = yield* fixture;
        const missing = assertError(
          yield* listRefs(actor, { cwd: `${root}/threads/missing` }).pipe(Effect.flip),
        );
        expect(missing.detail).toContain("thread is unavailable");
        state.threadProjectId = projectIdForDrive("folder/personal/other");
        const other = assertError(yield* listRefs(actor, { cwd: current.path }).pipe(Effect.flip));
        expect(other.detail).toContain("does not belong to this drive");
        expect(state.requests).toHaveLength(0);
        expect(state.remoteReads).toBe(0);
      }),
  );

  it.effect("returns contract errors for disconnected GitHub and failed drive reads", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      state.token = null;
      const disconnected = assertError(yield* listRefs(actor, { cwd: root }).pipe(Effect.flip));
      expect(disconnected.detail).toContain("Connect GitHub first");
      state.driveFailure = true;
      const unavailable = assertError(yield* listRefs(actor, { cwd: root }).pipe(Effect.flip));
      expect(unavailable.detail).toContain("drive is unavailable");
      expect(state.requests).toHaveLength(0);
    }),
  );

  it.effect("returns contract errors when refs become inaccessible or GitHub fails", () =>
    Effect.gen(function* () {
      const { listRefs, state } = yield* fixture;
      for (const status of [401, 403, 404, 429, 503]) {
        state.refsStatus = status;
        const error = assertError(yield* listRefs(actor, { cwd: root }).pipe(Effect.flip));
        expect(error).toMatchObject({ operation: "vcs.listRefs", cwd: root });
        expect(error.detail).toBe(
          status === 404
            ? "You can't open this repository on GitHub."
            : "GitHub refused this read.",
        );
      }
    }),
  );
});
