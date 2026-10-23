// @effect-diagnostics nodeBuiltinImport:off - disposable SQLite files verify durable bytes and authority.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { createHarnessFilesStore } from "../HarnessFilesStore.ts";
import { createHarnessThreadSupervisor } from "../HarnessThreadSupervisor.ts";
import type { HarnessFilesDatabase } from "./files/types.ts";
import type { HarnessThreadSupervisorDatabase } from "./supervisor/types.ts";

const runId = "durable-run";
const checkpoint0 = { checkpointId: "checkpoint-0", parentCheckpointId: null, files: [] };
const manifest0 = { checkpointId: "checkpoint-0", manifestSha256: "a".repeat(64) };
const control1 = {
  ownerId: "owner",
  incarnationId: "owner-incarnation-1",
  epoch: 1,
  controlKey: "controller-key-1-".repeat(3),
};
const publisher1 = {
  generation: 1,
  facetNonce: "facet-nonce-1",
  publisherKey: "publisher-key-1-".repeat(3),
};
const preparedPublisher2 = {
  generation: 2,
  facetNonce: "facet-nonce-2",
  publisherKey: "publisher-key-2-".repeat(3),
};
const control2 = {
  ownerId: "owner",
  incarnationId: "owner-incarnation-2",
  epoch: 2,
  controlKey: "controller-key-2-".repeat(3),
};

function database() {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  return {
    sql: {
      exec(query: string, ...bindings: (string | number | null | ArrayBuffer)[]) {
        const statement = sqlite.prepare(query);
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync<A>(operation: () => A): A {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => sqlite.close(),
  };
}

const dbs = new Set<ReturnType<typeof database>>();
afterEach(() => {
  for (const db of dbs) db.close();
  dbs.clear();
});

describe("harness durable stores", () => {
  it.effect(
    "stores checkpoint bytes outside a facet and reads them after service reconstruction",
    () =>
      Effect.gen(function* () {
        const fileDb = database() as ReturnType<typeof database> & HarnessFilesDatabase;
        dbs.add(fileDb);
        const first = createHarnessFilesStore(fileDb, runId);
        const initialized = yield* first.execute({
          type: "initialize",
          runId,
          control: control1,
          publisher: publisher1,
          checkpoint: {
            ...checkpoint0,
            files: [
              {
                path: "src/main.ts",
                mode: 0o644,
                bytes: new TextEncoder().encode("export const value = 1;\n"),
              },
            ],
          },
        });
        const fresh = createHarnessFilesStore(fileDb, runId);
        const recovered = yield* fresh.execute({
          type: "recoverCheckpoint",
          runId,
          publisher: publisher1,
          checkpointId: checkpoint0.checkpointId,
        });
        expect(recovered).toMatchObject({
          checkpoint: initialized.checkpoint,
          files: [{ path: "src/main.ts", mode: 0o644 }],
        });
        expect([...recovered.files[0]!.bytes]).toEqual([
          ...new TextEncoder().encode("export const value = 1;\n"),
        ]);
      }),
  );

  it.effect(
    "keeps stop acknowledgement separate from joined settlement and preserves native identity",
    () =>
      Effect.gen(function* () {
        const supervisorDb = database() as ReturnType<typeof database> &
          HarnessThreadSupervisorDatabase;
        dbs.add(supervisorDb);
        const first = createHarnessThreadSupervisor(supervisorDb, runId);
        yield* first.execute({
          type: "initialize",
          runId,
          nativeSessionId: "native-session-fixed",
          control: control1,
          publisher: publisher1,
          checkpoint: manifest0,
        });
        const fresh = createHarnessThreadSupervisor(supervisorDb, runId);
        yield* fresh.execute({
          type: "beginDrain",
          runId,
          control: control1,
          publisher: publisher1,
          expectedGeneration: 1,
          operationId: "drain-1",
          nextControl: control2,
        });
        const missingAck = yield* Effect.flip(
          fresh.execute({
            type: "settleInvocation",
            runId,
            control: control2,
            publisher: publisher1,
            expectedGeneration: 1,
            outcome: "stopped",
            invocationRpcJoined: true,
            fetchJoined: true,
            callbackPortsJoined: true,
          }),
        );
        expect(missingAck).toMatchObject({ code: "CONFLICT" });
        yield* fresh.execute({
          type: "recordStopAcknowledgement",
          runId,
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          requestId: "stop-request",
          acknowledgementId: "stop-ack",
        });
        const settled = yield* fresh.execute({
          type: "settleInvocation",
          runId,
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          outcome: "stopped",
          invocationRpcJoined: true,
          fetchJoined: true,
          callbackPortsJoined: true,
        });
        expect(settled.snapshot).toMatchObject({
          nativeSessionId: "native-session-fixed",
          lifecycle: "stopped",
          stopAcknowledgementId: "stop-ack",
          settlement: {
            outcome: "stopped",
            invocationRpcJoined: true,
            fetchJoined: true,
            callbackPortsJoined: true,
          },
        });
      }),
  );

  it.effect(
    "keeps lost drain retries idempotent without returning prepared authority to the old claim",
    () =>
      Effect.gen(function* () {
        const supervisorDb = database() as ReturnType<typeof database> &
          HarnessThreadSupervisorDatabase;
        dbs.add(supervisorDb);
        const store = createHarnessThreadSupervisor(supervisorDb, runId);
        yield* store.execute({
          type: "initialize",
          runId,
          nativeSessionId: "native-session-fixed",
          control: control1,
          publisher: publisher1,
          checkpoint: manifest0,
        });
        yield* store.execute({
          type: "beginDrain",
          runId,
          control: control1,
          publisher: publisher1,
          expectedGeneration: 1,
          operationId: "drain-1",
          nextControl: control2,
        });
        yield* store.execute({
          type: "recordStopAcknowledgement",
          runId,
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          requestId: "stop-request",
          acknowledgementId: "stop-ack",
        });
        yield* store.execute({
          type: "settleInvocation",
          runId,
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          outcome: "stopped",
          invocationRpcJoined: true,
          fetchJoined: true,
          callbackPortsJoined: true,
        });
        yield* store.execute({
          type: "prepareFreshFacet",
          runId,
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          operationId: "resume-1",
          preparedPublisher: preparedPublisher2,
        });

        const staleSettlement = yield* Effect.flip(
          store.execute({
            type: "settleInvocation",
            runId,
            control: control1,
            publisher: publisher1,
            expectedGeneration: 1,
            outcome: "stopped",
            invocationRpcJoined: true,
            fetchJoined: true,
            callbackPortsJoined: true,
          }),
        );
        expect(staleSettlement).toMatchObject({ code: "STALE_CONTROL" });

        const retried = yield* store.execute({
          type: "beginDrain",
          runId,
          control: control1,
          publisher: publisher1,
          expectedGeneration: 1,
          operationId: "drain-1",
          nextControl: control2,
        });
        expect(retried).toMatchObject({
          action: "unchanged",
          preparedPublisher: null,
          snapshot: { lifecycle: "preparing", preparedFacet: { operationId: "resume-1" } },
        });
        const current = yield* store.execute({ type: "read", runId, control: control2 });
        expect(current.preparedPublisher).toEqual(preparedPublisher2);
      }),
  );

  it.effect(
    "rejects a mismatched files generation and retires the prior publisher after publication",
    () =>
      Effect.gen(function* () {
        const fileDb = database() as ReturnType<typeof database> & HarnessFilesDatabase;
        dbs.add(fileDb);
        const files = createHarnessFilesStore(fileDb, runId);
        const initialized = yield* files.execute({
          type: "initialize",
          runId,
          control: control1,
          publisher: publisher1,
          checkpoint: checkpoint0,
        });
        const checkpoint = initialized.checkpoint;
        yield* files.execute({
          type: "syncControl",
          runId,
          control: control2,
          expectedGeneration: 1,
          operationId: "drain-1",
        });
        const wrongGeneration = yield* Effect.flip(
          files.execute({
            type: "publishFacet",
            runId,
            control: control2,
            publisher: publisher1,
            expectedGeneration: 2,
            preparedPublisher: preparedPublisher2,
            operationId: "resume-1",
            checkpoint,
          }),
        );
        expect(wrongGeneration).toMatchObject({ code: "OUT_OF_ORDER" });

        yield* files.execute({
          type: "publishFacet",
          runId,
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          preparedPublisher: preparedPublisher2,
          operationId: "resume-1",
          checkpoint,
        });
        const confirmed = yield* files.execute({
          type: "confirmFacetPublication",
          runId,
          control: control2,
          expectedGeneration: 1,
          preparedPublisher: preparedPublisher2,
          operationId: "resume-1",
          checkpoint,
        });
        expect(confirmed.publication).toMatchObject({
          fromGeneration: 1,
          toGeneration: 2,
          status: "confirmed",
        });
        const stalePublisher = yield* Effect.flip(
          files.execute({
            type: "readCheckpoint",
            runId,
            publisher: publisher1,
            checkpointId: checkpoint.checkpointId,
          }),
        );
        expect(stalePublisher).toMatchObject({ code: "STALE_PUBLISHER" });
      }),
  );
});
