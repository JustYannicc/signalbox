import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import * as SqliteSearchIndex from "./adapters/SqliteSearchIndex.ts";
import * as SearchIndex from "./SearchIndex.ts";

export const SEARCH_INDEX_OBJECT_JURISDICTION = "eu";

export interface SearchIndexObjectApi {
  readonly deliver: (delivery: SearchIndex.SearchDelivery) => Promise<void>;
  readonly query: (input: Parameters<SearchIndex.SearchIndex["Service"]["query"]>[0]) => Promise<{
    readonly candidates: ReadonlyArray<SearchIndex.SearchCandidate>;
    readonly hasMore: boolean;
  }>;
  readonly progress: (
    home: SearchIndex.SearchHome,
    threadIds: ReadonlyArray<string>,
  ) => Promise<
    ReadonlyArray<{
      readonly threadId: string;
      readonly revision: number;
      readonly complete: boolean;
    }>
  >;
}

export type SearchIndexObjectStub = SearchIndexObjectApi;

export interface SearchIndexNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly jurisdiction: (name: typeof SEARCH_INDEX_OBJECT_JURISDICTION) => {
    readonly idFromName: (name: string) => DurableObjectId;
  };
  readonly get: (id: DurableObjectId) => SearchIndexObjectStub;
}

export interface SearchIndexEnv {
  /** Optional for compatibility with existing Worker fixtures; the layer fails explicitly if absent. */
  readonly SEARCH_INDEX?: SearchIndexNamespace;
  /** Set by local workerd, which does not support jurisdictions. */
  readonly LOCAL_WORKERD?: string;
}

const HomeName = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const encodeHomeName = Schema.encodeSync(HomeName);
const decodeHomeTuple = Schema.decodeUnknownSync(HomeName);

const homeName = (home: SearchIndex.SearchHome) => encodeHomeName([home.ownerId, home.projectId]);

const decodeHome = (name: string | undefined): SearchIndex.SearchHome => {
  if (name === undefined) throw new Error("Search index objects must be named by their home.");
  const [ownerId, projectId] = decodeHomeTuple(name);
  return { ownerId, projectId };
};

const makeRuntime = (ctx: DurableObjectState, home: SearchIndex.SearchHome) =>
  ManagedRuntime.make(
    SqliteSearchIndex.layer(home).pipe(
      Layer.provideMerge(SqliteClient.layer({ storage: ctx.storage })),
    ),
  );

export class SearchIndexObject
  extends DurableObject<SearchIndexEnv>
  implements SearchIndexObjectApi
{
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: SearchIndexEnv) {
    super(ctx, env);
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== SEARCH_INDEX_OBJECT_JURISDICTION) {
      throw new Error("Search index objects must live in the EU jurisdiction.");
    }
    const home = decodeHome(ctx.id.name);
    this.runtime = makeRuntime(ctx, home);
    this.ready = this.runtime.runPromise(SqliteSearchIndex.initialize(home));
    void ctx.blockConcurrencyWhile(() => this.ready);
  }

  private run<A>(effect: Effect.Effect<A, SearchIndex.SearchIndexError, SearchIndex.SearchIndex>) {
    return this.ready.then(() => this.runtime.runPromise(effect));
  }

  deliver(delivery: SearchIndex.SearchDelivery) {
    return this.run(SearchIndex.SearchIndex.use((index) => index.deliver(delivery)));
  }

  query(input: Parameters<SearchIndexObjectApi["query"]>[0]) {
    return this.run(SearchIndex.SearchIndex.use((index) => index.query(input)));
  }

  progress(home: SearchIndex.SearchHome, threadIds: ReadonlyArray<string>) {
    return this.run(SearchIndex.SearchIndex.use((index) => index.progress(home, threadIds)));
  }
}

const missingBinding = (operation: string) =>
  Effect.fail(
    new SearchIndex.SearchIndexError({
      operation,
      cause: new Error("The SEARCH_INDEX Durable Object binding is not configured."),
    }),
  );

/** Worker service wiring; an absent binding remains a typed runtime failure. */
export const layerFromEnv = (env: SearchIndexEnv) => {
  const namespace = env.SEARCH_INDEX;
  if (namespace === undefined) {
    return Layer.succeed(
      SearchIndex.SearchIndex,
      SearchIndex.SearchIndex.of({
        deliver: () => missingBinding("deliver"),
        query: () => missingBinding("query"),
        progress: () => missingBinding("progress"),
      }),
    );
  }

  const stubFor = (home: SearchIndex.SearchHome) => {
    const ids =
      env.LOCAL_WORKERD === "1"
        ? namespace
        : namespace.jurisdiction(SEARCH_INDEX_OBJECT_JURISDICTION);
    return namespace.get(ids.idFromName(homeName(home)));
  };
  const call = <A>(
    operation: string,
    home: SearchIndex.SearchHome,
    invoke: (stub: SearchIndexObjectStub) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: () => invoke(stubFor(home)),
      catch: (cause) => new SearchIndex.SearchIndexError({ operation, cause }),
    });

  return Layer.succeed(
    SearchIndex.SearchIndex,
    SearchIndex.SearchIndex.of({
      deliver: (delivery) => call("deliver", delivery.home, (stub) => stub.deliver(delivery)),
      query: (input) => call("query", input.home, (stub) => stub.query(input)),
      progress: (home, threadIds) =>
        call("progress", home, (stub) => stub.progress(home, threadIds)),
    }),
  );
};
