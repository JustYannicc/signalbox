import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { makeSecretScrubber } from "@signalbox/runner-protocol/SecretScrubber";
import { expect, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  beginSecretRun,
  migrateSecretRegistrationRunIdentity,
  migrateSecretRegistrationThroughCurrentValues,
  registerSecretValues,
  readSecretValues,
} from "../secretRegistrationTesting.ts";

it.effect("persists current-only secret values in redaction history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const generation = 3;
    const runId = RunId.make("run-current-only");
    const value = "current-only-fixture";
    const current = [{ name: "KEY", value }];

    yield* migrateSecretRegistrationThroughCurrentValues;
    yield* migrateSecretRegistrationRunIdentity;
    yield* beginSecretRun(generation, runId).pipe(sql.withTransaction);
    expect(
      yield* registerSecretValues(generation, runId, [], current).pipe(sql.withTransaction),
    ).toBe(true);

    const snapshot = yield* readSecretValues;
    expect(snapshot).toEqual({
      registered: generation,
      registeredRunId: runId,
      revision: 3,
      current,
      values: current,
    });
    expect(makeSecretScrubber(snapshot.values).text(`echo ${value}`)).toBe("echo {{secret:KEY}}");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("0013 invalidates pre-run fills and sources while retaining redaction history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrateSecretRegistrationThroughCurrentValues;
    yield* sql`INSERT INTO secret_values (name, value) VALUES ('KEY', 'upgrade-history-fixture')`;
    yield* sql`INSERT INTO secret_registration (id, generation) VALUES (1, 3)`;
    yield* sql`INSERT INTO secret_current_values (name, value) VALUES ('KEY', 'upgrade-history-fixture')`;
    yield* sql`INSERT INTO secret_sources (name, environment) VALUES ('KEY', 'env-old')`;
    yield* sql`UPDATE secret_current_registration SET revision = 4 WHERE id = 1`;

    yield* migrateSecretRegistrationRunIdentity.pipe(sql.withTransaction);

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
