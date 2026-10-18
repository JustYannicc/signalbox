import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";

import * as SearchIndex from "../SearchIndex.ts";
import * as SqliteSearchIndex from "../SqliteSearchIndex.ts";

const home = { ownerId: "owner", projectId: "project" };
const maximumQuery = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(
  " ",
);

export class QueryIndex extends DurableObject<unknown> {
  private readonly runtime;
  private readonly ready;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.runtime = ManagedRuntime.make(
      SqliteSearchIndex.layer(home).pipe(
        Layer.provideMerge(SqliteClient.layer({ storage: ctx.storage })),
      ),
    );
    this.ready = this.runtime.runPromise(
      Effect.gen(function* () {
        yield* SqliteSearchIndex.initialize(home);
        const index = yield* SearchIndex.SearchIndex;
        yield* index.deliver({
          home,
          thread: { threadId: "thread", title: "Search fixture", archived: false, deleted: false },
          revision: 1,
          sourceSequence: 1,
          deliveryId: "fixture",
          removed: [],
          complete: true,
          documents: [
            {
              threadId: "thread",
              itemId: "split",
              entryId: "entry-split",
              runId: null,
              position: 0,
              kind: "assistant",
              createdAt: null,
              text: `alpha ${"padding ".repeat(3000)} beta ${"other ".repeat(3000)} gamma`,
            },
            {
              threadId: "thread",
              itemId: "maximum",
              entryId: "entry-maximum",
              runId: null,
              position: 1,
              kind: "assistant",
              createdAt: null,
              text: maximumQuery,
            },
          ],
        });
        const sql = yield* SqlClient.SqlClient;
        const text = "legacy alpha beta gamma";
        const [legacy] = yield* sql<{ readonly id: number }>`INSERT INTO search_documents
          (thread_id, item_id, entry_id, run_id, position, kind, text, search_text,
            literal_text, created_at, revision)
          VALUES ('thread', 'legacy', 'entry-legacy', NULL, 2, 'assistant', ${text},
            ${text}, ${text}, NULL, 1) RETURNING id`;
        if (legacy === undefined) throw new Error("Legacy fixture insert returned no id.");
        yield* sql`INSERT INTO search_documents_fts (rowid, search_text)
          VALUES (${legacy.id}, ${text})`;
      }),
    );
  }

  override async fetch(request: Request) {
    await this.ready;
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const result = await this.runtime.runPromise(
      SearchIndex.SearchIndex.use((index) =>
        index.query({
          home,
          threadIds: ["thread"],
          query,
          mode: "keyword",
          after: null,
          limit: 20,
        }),
      ),
    );
    return Response.json(result);
  }
}

export default {
  fetch(request: Request, env: { INDEX: DurableObjectNamespace }) {
    return env.INDEX.get(env.INDEX.idFromName("fixture")).fetch(request);
  },
};
