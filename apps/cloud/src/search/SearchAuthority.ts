import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { contextAllows, parseDriveId } from "../drive/driveAccess.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserStore from "../user/UserStore.ts";
import type { SearchHome } from "./SearchIndex.ts";
import { searchHomeForThread } from "./searchHome.ts";
import { SearchIndexError } from "./SearchIndex.ts";

export type SearchActor = Actor & { readonly projectIds?: ReadonlyArray<string> };

export interface SearchScope {
  readonly actor: Actor;
  readonly revision: number;
  readonly homes: ReadonlyArray<{
    readonly home: SearchHome;
    readonly threadIds: ReadonlyArray<string>;
  }>;
}

/** Current grants, never the index's cached ACL. The owner-only baseline matches cloud threads. */
export class SearchAuthority extends Context.Service<
  SearchAuthority,
  {
    readonly current: (actor: SearchActor) => Effect.Effect<SearchScope, SearchIndexError>;
  }
>()("@signalbox/cloud/search/SearchAuthority") {}

const make = Effect.gen(function* () {
  const store = yield* UserStore.UserStore;
  const contexts = yield* UserContexts.UserContexts;
  const drives = yield* UserDrives.UserDrives;
  return SearchAuthority.of({
    current: (actor) =>
      Effect.gen(function* () {
        const profile = yield* store.profile;
        const revision = yield* contexts.revision;
        const contextIds = (yield* contexts.contextIds).filter((id) =>
          actor.contextIds.includes(id),
        );
        const currentActor = {
          userId: actor.userId,
          contextIds,
          ...(actor.projectIds === undefined ? {} : { projectIds: actor.projectIds }),
        };
        if (profile?.id !== actor.userId) return { actor: currentActor, revision, homes: [] };
        const index = yield* store.threadIndex;
        const homes = new Map<string, { home: SearchHome; threadIds: Array<string> }>();
        const access = new Map<string, boolean>();
        for (const row of index.threads) {
          if (!contextAllows(contextIds, row.contextId) || row.shell.deletedAt !== null) continue;
          if (actor.projectIds !== undefined && !actor.projectIds.includes(row.shell.projectId))
            continue;
          const driveId = driveOfProject(row.shell.projectId, actor.userId);
          if (driveId === null || parseDriveId(driveId)?.contextId !== row.contextId) continue;
          let allowed = access.get(driveId);
          if (allowed === undefined) {
            allowed = (yield* drives.access(driveId)) !== null;
            access.set(driveId, allowed);
          }
          if (!allowed) continue;
          const home = searchHomeForThread(actor.userId, row.contextId, row.shell.projectId);
          const key = `${home.ownerId}/${home.projectId}`;
          const entry = homes.get(key) ?? { home, threadIds: [] };
          entry.threadIds.push(row.shell.id);
          homes.set(key, entry);
        }
        return {
          actor: currentActor,
          revision,
          homes: [...homes]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([, entry]) => ({
              home: entry.home,
              threadIds: entry.threadIds.sort(),
            })),
        };
      }).pipe(Effect.mapError((cause) => new SearchIndexError({ operation: "authority", cause }))),
  });
});

export const layerUser = Layer.effect(SearchAuthority, make);
