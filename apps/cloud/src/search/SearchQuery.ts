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
import * as Option from "effect/Option";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import type { SearchActor } from "./ThreadSearch.ts";
import * as SearchAuthority from "./SearchAuthority.ts";
import * as SearchIndex from "./SearchIndex.ts";
import * as SearchCursors from "./SearchCursors.ts";
import * as SearchBackfill from "./SearchBackfill.ts";
import { compareSearchKeys, searchKey } from "./searchOrdering.ts";
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
  const backfill = yield* Effect.serviceOption(SearchBackfill.SearchBackfill);

  const fingerprintFor = (
    actor: SearchActor,
    scope: SearchAuthority.SearchScope,
    input: ThreadSearchInput,
    legacy: boolean,
    activation: string | null | undefined,
  ) =>
    crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          encodeFingerprint({
            version: 2,
            actor: actor.userId,
            contexts: [...scope.actor.contextIds].sort(),
            representedProjects:
              actor.projectIds === undefined ? null : [...actor.projectIds].sort(),
            grants: [...new Set(scope.grants.map(homeKey))].sort(),
            projects: input.projectIds === undefined ? null : [...input.projectIds].sort(),
            thread: input.threadId ?? null,
            query: input.query,
            mode: input.mode ?? "keyword",
            kinds: input.kinds === undefined ? null : [...input.kinds].sort(),
            distinctThreads: legacy || input.distinctThreads === true,
            order: legacy ? "legacy" : "rich",
            limit: input.limit ?? 20,
            generation: index.generation,
            activation: activation ?? null,
          }),
        ),
      )
      .pipe(Effect.map(Hex.encode), Effect.orDie);

  const queryItems = (
    actor: SearchActor,
    input: ThreadSearchInput,
    legacy = false,
  ): Effect.Effect<ThreadSearchResult, ThreadSearchError> =>
    Effect.gen(function* () {
      if (index.disabled) return yield* unavailable();
      const activation = Option.isSome(backfill)
        ? yield* backfill.value.activation.pipe(Effect.mapError(unavailable))
        : undefined;
      const scope = yield* authority.current(actor);
      const fingerprint = yield* fingerprintFor(actor, scope, input, legacy, activation);
      const cursor = input.cursor === undefined ? null : yield* cursors.read(input.cursor);
      if (input.cursor !== undefined && (cursor === null || cursor.fingerprint !== fingerprint))
        return yield* expired();
      const mode = input.mode ?? "keyword";
      const distinctThreads = legacy || input.distinctThreads === true;
      const seen = new Set(distinctThreads && cursor !== null ? yield* cursors.seen(cursor) : []);
      const emitted: Array<string> = [];
      const partitions = scopeFor(scope, input).map((partition) => ({
        ...partition,
        buffer: [] as Array<SearchIndex.SearchCandidate>,
        after: cursor?.after ?? null,
        more: true,
      }));
      let available = true;
      const refill = (partition: (typeof partitions)[number]) =>
        Effect.gen(function* () {
          if (partition.buffer.length > 0 || !partition.more) return;
          const page = yield* index
            .query({
              home: partition.home,
              threadIds: distinctThreads
                ? partition.threadIds.filter((id) => !seen.has(id))
                : partition.threadIds,
              query: input.query,
              mode,
              distinctThreads: false,
              order: legacy ? "legacy" : "rich",
              ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
              after: partition.after,
              limit: 50,
            })
            .pipe(
              Effect.catchTags({
                SearchIndexError: () => {
                  available = false;
                  return Effect.succeed({ candidates: [], hasMore: false });
                },
              }),
            );
          partition.buffer.push(...page.candidates);
          partition.more = page.hasMore;
          const last = page.candidates.at(-1);
          if (last !== undefined) partition.after = searchKey(last);
          // An adapter cannot advance an empty page; avoid a retry loop on bad responses.
          else partition.more = false;
        });
      yield* Effect.forEach(partitions, refill, { concurrency: 4 });
      const hits: Array<ThreadSearchHit> = [];
      let consumed = 0;
      let after = cursor?.after ?? null;
      let unconsumed = false;
      const limit = input.limit ?? 20;
      while (consumed < 500 && hits.length < limit) {
        const selected: Array<{
          home: SearchIndex.SearchHome;
          candidate: SearchIndex.SearchCandidate;
        }> = [];
        while (selected.length < Math.min(50, 500 - consumed)) {
          yield* Effect.forEach(partitions, refill, { concurrency: 4 });
          const next = partitions
            .filter((p) => p.buffer.length > 0)
            .sort((a, b) => compareSearchKeys(a.buffer[0]!, b.buffer[0]!))[0];
          if (next === undefined) break;
          selected.push({ home: next.home, candidate: next.buffer.shift()! });
        }
        if (selected.length === 0) break;
        const current = yield* authority.current(actor);
        const allowed = new Map(
          scopeFor(current, input).map((p) => [homeKey(p.home), new Set(p.threadIds)]),
        );
        const grouped = new Map<string, Array<SearchIndex.SearchCandidate>>();
        for (const { home, candidate } of selected) {
          if (!allowed.get(homeKey(home))?.has(candidate.threadId)) continue;
          const group = grouped.get(candidate.threadId) ?? [];
          group.push(candidate);
          grouped.set(candidate.threadId, group);
        }
        const records = new Map(
          yield* Effect.forEach(
            [...grouped],
            ([id, candidates]) =>
              threads
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
                  Effect.map((record) => [id, record] as const),
                ),
            { concurrency: 4 },
          ),
        );
        for (let position = 0; position < selected.length; position++) {
          const { home, candidate } = selected[position]!;
          consumed++;
          after = searchKey(candidate);
          const record = records.get(candidate.threadId);
          if (
            record === null ||
            record === undefined ||
            record.deleted ||
            record.projectId !== home.projectId
          )
            continue;
          const document = record.documents.find((d) => d.itemId === candidate.itemId);
          if (document === undefined || !matchesSearchText(document.text, input.query, mode))
            continue;
          if (input.kinds !== undefined && !input.kinds.includes(document.kind)) continue;
          if (distinctThreads && seen.has(candidate.threadId)) continue;
          seen.add(candidate.threadId);
          emitted.push(candidate.threadId);
          hits.push({
            threadId: ThreadId.make(candidate.threadId),
            projectId: ProjectId.make(home.projectId),
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
            unconsumed = position < selected.length - 1;
            break;
          }
        }
      }
      const more = unconsumed || partitions.some((p) => p.buffer.length > 0 || p.more);
      const finalScope = yield* authority.current(actor);
      if ((yield* fingerprintFor(actor, finalScope, input, legacy, activation)) !== fingerprint)
        return yield* expired();
      const finalHomes = scopeFor(finalScope, input);
      const finalAllowed = new Map(finalHomes.map((p) => [homeKey(p.home), new Set(p.threadIds)]));
      const finalHits = hits.filter((hit) =>
        finalHomes.some(
          (p) =>
            p.home.projectId === hit.projectId &&
            finalAllowed.get(homeKey(p.home))?.has(hit.threadId),
        ),
      );
      const completedByHome = new Map<string, ReadonlySet<string>>();
      for (const { home, threadIds } of finalHomes) {
        const progress = yield* index.progress(home, threadIds).pipe(
          Effect.catchTags({
            SearchIndexError: () => {
              available = false;
              return Effect.succeed([]);
            },
          }),
        );
        const allowedIds = new Set(threadIds);
        const complete = new Set(
          progress
            .filter(
              (row) =>
                row.complete &&
                allowedIds.has(row.threadId) &&
                (activation === undefined ||
                  (activation !== null && row.activation === activation)),
            )
            .map((row) => row.threadId),
        );
        completedByHome.set(homeKey(home), complete);
      }
      // Progress reads also cross object boundaries, so recheck grants after those reads.
      const checkedScope = yield* authority.current(actor);
      if ((yield* fingerprintFor(actor, checkedScope, input, legacy, activation)) !== fingerprint)
        return yield* expired();
      const checkedHomes = scopeFor(checkedScope, input);
      const checkedIds = new Set(checkedHomes.flatMap((p) => p.threadIds));
      let indexedThreads = 0;
      let pendingThreads = 0;
      for (const partition of checkedHomes) {
        const complete = completedByHome.get(homeKey(partition.home));
        const indexed = partition.threadIds.filter((id) => complete?.has(id)).length;
        indexedThreads += indexed;
        pendingThreads += partition.threadIds.length - indexed;
      }
      return {
        hits: finalHits.filter((hit) => checkedIds.has(hit.threadId)),
        nextCursor:
          more && after !== null
            ? yield* cursors.save(
                { version: 2, fingerprint, after },
                cursor,
                distinctThreads ? emitted : [],
              )
            : null,
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
