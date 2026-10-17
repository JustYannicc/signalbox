import type { SearchThreadCursor } from "@signalbox/runner-protocol/ContextProtocol";
import { ThreadId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { ThreadDirectory, ThreadObjectError } from "../thread/ThreadDirectory.ts";
import { projectIdForDrive } from "../user/contextProjects.ts";
import { searchContext } from "./contextSearch.ts";

const driveId = "shared/org_acme/billing";
const reader = { userId: "user_alice", threadId: "current", driveId: "my/personal/user_alice" };
const actor = { userId: reader.userId, contextIds: [] };
const terms = ["searchtoken"];

const shellThread = (id: string, updatedAt: number, archivedAt: number | null = null) => ({
  id: ThreadId.make(id),
  title: id,
  projectId: projectIdForDrive(driveId),
  updatedAt: DateTime.makeUnsafe(updatedAt),
  archivedAt: archivedAt === null ? null : DateTime.makeUnsafe(archivedAt),
});

const shell = (threads: ReadonlyArray<unknown>, archivedThreads: ReadonlyArray<unknown> = []) =>
  ({ threads, archivedThreads }) as unknown as OrchestrationV2ShellSnapshot;

const threadMatch = (id: string) => ({
  title: id,
  matched: terms,
  files: [],
  messages: [{ messageId: `message-${id}`, turn: null, role: "user", excerpt: "searchtoken" }],
  messagesTruncated: false,
  turns: [],
});

const search = (input: {
  readonly shell: OrchestrationV2ShellSnapshot;
  readonly includeArchived?: boolean;
  readonly threadCursor?: SearchThreadCursor | null;
  readonly unreadableThreadIds?: ReadonlySet<string>;
}) =>
  searchContext({
    reader,
    actor,
    query: "searchtoken",
    driveIds: [driveId],
    ...input,
  }).pipe(
    Effect.provideService(ThreadDirectory, {
      forThread: (threadId: ThreadId) =>
        ({
          contextMatch: () =>
            input.unreadableThreadIds?.has(String(threadId))
              ? Effect.fail(
                  new ThreadObjectError({ operation: "contextMatch", cause: new Error("offline") }),
                )
              : Effect.succeed(
                  String(threadId) === "archived-match" || String(threadId) === "thread-oldest"
                    ? threadMatch(String(threadId))
                    : null,
                ),
        }) as never,
    } as never),
    Effect.provideService(DriveDirectory, {
      forDrive: () => ({
        ref: () => Effect.succeed(null),
        unreconciled: () => Effect.succeed([]),
      }),
    } as never),
    Effect.provideService(DrivePacks, {} as never),
  );

describe("context search coverage", () => {
  it.effect(
    "excludes archived threads by default and labels an explicitly included archived hit",
    () =>
      Effect.gen(function* () {
        const archived = shellThread("archived-match", 1, 0);
        const threads = shell([], [archived]);

        const ordinary = yield* search({ shell: threads });
        expect(ordinary._tag).toBe("insufficient_evidence");
        expect(ordinary.searched).toMatchObject({ threads: 0, threadsInScope: 0 });

        const included = yield* search({ shell: threads, includeArchived: true });
        expect(included).toMatchObject({
          _tag: "found",
          hits: [{ kind: "thread", threadId: "archived-match", archived: true }],
        });
      }),
  );

  it.effect("continues into older threads and reports page coverage", () =>
    Effect.gen(function* () {
      const recent = Array.from({ length: 40 }, (_, index) =>
        shellThread(`thread-recent-${index.toString().padStart(2, "0")}`, 100),
      );
      const snapshot = shell([shellThread("thread-oldest", 0), ...recent]);

      const first = yield* search({ shell: snapshot });
      expect(first._tag).toBe("insufficient_evidence");
      expect(first._tag === "insufficient_evidence" && first.reason).toMatch(/More threads remain/);
      expect(first.searched).toMatchObject({ threads: 40, threadsInScope: 41 });
      const cursor = first.nextThreadCursor;
      expect(cursor).toEqual(expect.any(Object));

      const anchorMoved = shell([
        shellThread("thread-oldest", 0),
        ...recent.slice(0, -1),
        shellThread("thread-recent-39", 200),
      ]);
      const second = yield* search({ shell: anchorMoved, threadCursor: cursor ?? null });
      expect(second).toMatchObject({
        _tag: "found",
        hits: [{ kind: "thread", threadId: "thread-oldest" }],
        searched: { threads: 1, threadsInScope: 41 },
      });
      expect(second.nextThreadCursor).toBeNull();
    }),
  );

  it.effect("reports an unreadable thread instead of claiming complete coverage", () =>
    Effect.gen(function* () {
      const result = yield* search({
        shell: shell([shellThread("unreadable", 0)]),
        unreadableThreadIds: new Set(["unreadable"]),
      });

      expect(result).toMatchObject({
        _tag: "insufficient_evidence",
        searched: { threads: 0, threadReadFailures: 1, threadsInScope: 1 },
        nextThreadCursor: null,
        threadCoverageComplete: false,
      });
      expect(result._tag === "insufficient_evidence" && result.reason).toMatch(
        /rerun from the first page to retry those reads/,
      );
    }),
  );
});
