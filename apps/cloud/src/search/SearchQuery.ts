import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  type ThreadSearchInput,
  type ThreadSearchResult,
  type ThreadSearchHit,
  ThreadSearchError,
} from "@t3tools/contracts/signalboxSearch";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import { type SearchActor } from "./SearchAuthority.ts";
import * as SearchAuthority from "./SearchAuthority.ts";
import * as SearchIndex from "./SearchIndex.ts";
import * as SearchCursors from "./SearchCursors.ts";
import { matchesSearchText, searchSnippet } from "./searchText.ts";

const unavailable = () => new ThreadSearchError({ reason: "unavailable" });
const expired = () => new ThreadSearchError({ reason: "cursor_expired" });
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const homeKey = (home: SearchIndex.SearchHome) => encodeStrings([home.ownerId, home.projectId]);
const scopeFor = (scope: SearchAuthority.SearchScope, input: ThreadSearchInput) =>
  scope.homes
    .filter(
      ({ home }) =>
        input.projectIds === undefined || input.projectIds.includes(ProjectId.make(home.projectId)),
    )
    .map(({ home, threadIds }) => ({
      home,
      threadIds:
        input.threadId === undefined ? threadIds : threadIds.filter((id) => id === input.threadId),
    }))
    .filter(({ threadIds }) => threadIds.length > 0);

/** Resolves authorized candidates, verifies current items, and advances opaque pages. */
export const make = Effect.gen(function* () {
  const index = yield* SearchIndex.SearchIndex;
  const authority = yield* SearchAuthority.SearchAuthority;
  const threads = yield* ThreadDirectory.ThreadDirectory;
  const crypto = yield* Crypto.Crypto;
  const cursors = yield* SearchCursors.SearchCursors;

  const fingerprintFor = (
    actor: SearchActor,
    scope: SearchAuthority.SearchScope,
    input: ThreadSearchInput,
  ) =>
    crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          encodeFingerprint({
            version: 1,
            actor: actor.userId,
            revision: scope.revision,
            homes: scopeFor(scope, input),
            query: input.query,
            mode: input.mode ?? "keyword",
            kinds: input.kinds ?? null,
          }),
        ),
      )
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const queryItems = (
    actor: SearchActor,
    input: ThreadSearchInput,
    distinctThreads = false,
  ): Effect.Effect<ThreadSearchResult, ThreadSearchError> =>
    Effect.gen(function* () {
      const scope = yield* authority.current(actor);
      const homes = scopeFor(scope, input);
      const fingerprint = yield* fingerprintFor(actor, scope, input);
      const cursor = input.cursor === undefined ? null : yield* cursors.read(input.cursor);
      if (input.cursor !== undefined && (cursor === null || cursor.fingerprint !== fingerprint))
        return yield* expired();
      if (cursor !== null && !homes.some(({ home }) => homeKey(home) === cursor.home))
        return yield* expired();

      let indexedThreads = 0;
      let pendingThreads = 0;
      let available = true;
      for (const { home, threadIds } of homes) {
        const progress = yield* index.progress(home, threadIds).pipe(
          Effect.catchTags({
            SearchIndexError: () => {
              available = false;
              return Effect.succeed([]);
            },
          }),
        );
        const complete = new Set(progress.filter((row) => row.complete).map((row) => row.threadId));
        indexedThreads += complete.size;
        pendingThreads += threadIds.length - complete.size;
      }

      const hits: Array<ThreadSearchHit> = [];
      const limit = input.limit ?? 20;
      const mode = input.mode ?? "keyword";
      let nextCursor: string | null = null;
      let budget = 500;
      const start =
        cursor === null ? 0 : homes.findIndex(({ home }) => homeKey(home) === cursor.home);
      outer: for (let h = start; h < homes.length; h++) {
        const partition = homes[h]!;
        let after = h === start ? (cursor?.after ?? null) : null;
        while (budget > 0) {
          const page = yield* index
            .query({
              ...partition,
              query: input.query,
              mode,
              distinctThreads,
              ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
              after,
              limit: Math.min(50, budget),
            })
            .pipe(
              Effect.catchTags({
                SearchIndexError: () => {
                  available = false;
                  return Effect.succeed({ candidates: [], hasMore: false });
                },
              }),
            );
          const grouped = new Map<string, Array<SearchIndex.SearchCandidate>>();
          for (const candidate of page.candidates) {
            const group = grouped.get(candidate.threadId) ?? [];
            group.push(candidate);
            grouped.set(candidate.threadId, group);
          }
          // Fetch only selected items, with the latest grants. Never trust cached ACLs or snippets.
          const current = yield* authority.current(actor);
          const allowed = new Set(
            scopeFor(current, input).flatMap((p) =>
              homeKey(p.home) === homeKey(partition.home) ? p.threadIds : [],
            ),
          );
          const verified = yield* Effect.forEach(
            [...grouped],
            ([id, candidates]) =>
              allowed.has(id)
                ? threads
                    .forThread(ThreadId.make(id))
                    .searchDocuments(
                      current.actor,
                      candidates.map((c) => c.itemId),
                    )
                    .pipe(
                      Effect.catchTags({
                        ThreadObjectError: () => {
                          available = false;
                          return Effect.succeed(null);
                        },
                      }),
                    )
                : Effect.succeed(null),
            { concurrency: 4 },
          );
          const records = new Map([...grouped.keys()].map((id, i) => [id, verified[i]]));
          for (let c = 0; c < page.candidates.length; c++) {
            const candidate = page.candidates[c]!;
            budget--;
            after = { threadId: candidate.threadId, itemId: candidate.itemId };
            const record = records.get(candidate.threadId);
            if (
              record === null ||
              record === undefined ||
              record.deleted ||
              record.projectId !== partition.home.projectId
            )
              continue;
            const document = record.documents.find((d) => d.itemId === candidate.itemId);
            if (document === undefined || !matchesSearchText(document.text, input.query, mode))
              continue;
            if (input.kinds !== undefined && !input.kinds.includes(document.kind)) continue;
            hits.push({
              threadId: ThreadId.make(candidate.threadId),
              projectId: ProjectId.make(partition.home.projectId),
              title: record.title,
              archived: record.archived,
              itemId: document.itemId,
              entryId: document.entryId,
              runId: document.runId,
              position: document.position,
              kind: document.kind,
              snippet: searchSnippet(document.text, input.query),
              createdAt: document.createdAt,
              sourceSequence: record.snapshotSequence,
              indexedThrough: candidate.sourceSequence,
            });
            if (hits.length >= limit) {
              if (c < page.candidates.length - 1 || page.hasMore || h < homes.length - 1) {
                nextCursor = yield* cursors.save({
                  version: 1,
                  fingerprint,
                  home: homeKey(partition.home),
                  after,
                });
              }
              break outer;
            }
          }
          if (!page.hasMore) break;
          if (budget <= 0) {
            nextCursor = yield* cursors.save({
              version: 1,
              fingerprint,
              home: homeKey(partition.home),
              after,
            });
            break outer;
          }
        }
      }
      // A membership change during index/record reads invalidates the entire page, including coverage.
      const finalScope = yield* authority.current(actor);
      if ((yield* fingerprintFor(actor, finalScope, input)) !== fingerprint)
        return yield* expired();
      return {
        hits,
        nextCursor,
        coverage: {
          complete: available && pendingThreads === 0,
          indexedThreads,
          pendingThreads,
          available,
        },
      };
    }).pipe(Effect.catchTags({ SearchIndexError: () => Effect.fail(unavailable()) }));

  return queryItems;
});
