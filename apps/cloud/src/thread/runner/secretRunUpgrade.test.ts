import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrateSecretSends } from "../egress/secretSendTables.ts";
import {
  migrateCurrentSecretValues,
  migrateSecretRunIdentity,
  migrateSecretValues,
  readSecretValues,
} from "./secretValues.ts";

it.effect("0013 invalidates pre-run fills and sources while retaining redaction history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrateSecretValues;
    yield* migrateSecretSends;
    yield* migrateCurrentSecretValues;
    yield* sql`INSERT INTO secret_values (name, value) VALUES ('KEY', 'upgrade-history-fixture')`;
    yield* sql`INSERT INTO secret_registration (id, generation) VALUES (1, 3)`;
    yield* sql`INSERT INTO secret_current_values (name, value) VALUES ('KEY', 'upgrade-history-fixture')`;
    yield* sql`INSERT INTO secret_sources (name, environment) VALUES ('KEY', 'env-old')`;
    yield* sql`UPDATE secret_current_registration SET revision = 4 WHERE id = 1`;

    yield* migrateSecretRunIdentity.pipe(sql.withTransaction);

    const snapshot = yield* readSecretValues;
    expect(snapshot).toEqual({
      registered: 3,
      registeredRunId: null,
      revision: 5,
      current: [],
      values: [{ name: "KEY", value: "upgrade-history-fixture" }],
    });
    expect(yield* sql`SELECT name, environment FROM secret_sources`).toEqual([]);
    expect(
      yield* sql`SELECT active_generation, active_run_id FROM secret_current_registration WHERE id = 1`,
    ).toEqual([{ active_generation: null, active_run_id: null }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
