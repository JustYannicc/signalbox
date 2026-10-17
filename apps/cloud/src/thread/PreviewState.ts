import { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export interface PreviewConfiguration {
  readonly key: string;
  readonly services: ReadonlyArray<PreviewService>;
}

export class PreviewState extends Context.Service<
  PreviewState,
  {
    readonly configuration: Effect.Effect<PreviewConfiguration, SqlError>;
    readonly saveServices: (
      services: ReadonlyArray<PreviewService>,
    ) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/thread/PreviewState") {}

const servicesJson = Schema.fromJsonString(Schema.Array(PreviewService));
const encodeServices = Schema.encodeSync(servicesJson);
const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ key: Schema.String, services: servicesJson })),
);

export const layer = Layer.effect(
  PreviewState,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    // This key belongs to the thread, so changing machines never invalidates a browser session.
    const initialize = sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS thread_previews (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        key TEXT NOT NULL,
        services TEXT NOT NULL
      )`;
        const key = Hex.encode(yield* Effect.orDie(crypto.randomBytes(32)));
        yield* sql`INSERT INTO thread_previews (id, key, services) VALUES (1, ${key}, '[]')
        ON CONFLICT (id) DO NOTHING`;
      }),
    );
    yield* initialize;

    return PreviewState.of({
      configuration: Effect.map(
        sql`SELECT key, services FROM thread_previews WHERE id = 1`,
        (rows) => decodeRows(rows)[0]!,
      ),
      saveServices: (services) =>
        sql`UPDATE thread_previews SET services = ${encodeServices(services)} WHERE id = 1`.pipe(
          Effect.asVoid,
        ),
    });
  }),
);
