// @effect-diagnostics nodeBuiltinImport:off - the supplemental process proof uses an isolated actual SQLite RunStore.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import { afterEach } from "@effect/vitest";
import { createHarnessRunStore, type HarnessRunDatabase } from "../../HarnessRunStore.ts";

const handles = new Set<NodeSqlite.DatabaseSync>();
afterEach(() => {
  for (const handle of handles) handle.close();
  handles.clear();
});
export const runId = "plain-process-run";
export const reference = (id: string) => ({ id, sha256: "a".repeat(64), bytes: 4 });
export const controlKey = "plain-controller-secret-".repeat(3);
const supervisorKey = "plain-supervisor-one-key-".repeat(3);
const replacementKey = "plain-supervisor-two-key-".repeat(3);
export const initial = {
  type: "initialize",
  seed: {
    identity: {
      runId,
      hostId: "host",
      threadId: "thread",
      logicalTurnId: "turn",
      filesystemId: "files",
    },
    locator: reference("facet-locator"),
    config: reference("config"),
    artifacts: [reference("executable")],
  },
  controlKey,
  supervisorKey,
  claimId: "parent-one",
  requestId: "initialize-one",
};
export const supervisor = { epoch: 1, claimId: "parent-one", supervisorKey };
export const takeover = {
  type: "takeover",
  runId,
  controlKey,
  supervisorKey: replacementKey,
  expectedEpoch: 1,
  claimId: "parent-two",
  requestId: "takeover-two",
};
export const replacement = { epoch: 2, claimId: "parent-two", supervisorKey: replacementKey };
export const install = (generation: number) => ({
  type: "request.replaceFacet",
  runId,
  controlKey,
  expectedGeneration: generation - 1,
  operationId: `replace-${generation}`,
  facetNonce: `facet-${generation}`,
  publisherKey: `publisher-for-generation-${generation}-`.repeat(2),
});
export const requestPublisher = (generation: number) => ({
  generation,
  facetNonce: install(generation).facetNonce,
  publisherKey: install(generation).publisherKey,
});
export function createSqliteRunStore(runId: string) {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  handles.add(sqlite);
  const database: HarnessRunDatabase = {
    sql: {
      exec(query, ...bindings) {
        const statement = sqlite.prepare(query);
        if (statement.columns().length > 0) return statement.all(...bindings);
        statement.run(...bindings);
        return [];
      },
    },
    transactionSync(operation) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const value = operation();
        sqlite.exec("COMMIT");
        return value;
      } catch (cause) {
        sqlite.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  const execute = (command: unknown) =>
    Effect.runPromise(createHarnessRunStore(database, runId).execute(command));
  return {
    call: execute,
    execute,
    close() {
      if (handles.delete(sqlite)) sqlite.close();
    },
  };
}

export function runStoreFixture() {
  return { open: () => createSqliteRunStore(runId) };
}
