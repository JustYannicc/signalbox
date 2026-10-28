// @effect-diagnostics nodeBuiltinImport:off - these cases exercise the real SQLite RunStore reader.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import { createHarnessRunStore, type HarnessRunDatabase } from "../../../HarnessRunStore.ts";
import { readHarnessRunStoreProcessSource } from "../../../HarnessRunStore.ts";
import { terminalKey } from "../../../processResume/terminalContract.ts";
import type {
  HarnessLegacyProcessSourceEnvironment,
  HarnessLegacyProcessSourceOperation,
} from "../../legacySource.ts";

export const runId = "legacy-process-source-run";
export const controlKey = "legacy-source-controller-key-".repeat(2);
export const supervisor = {
  epoch: 1,
  claimId: "legacy-source-supervisor-claim",
  supervisorKey: "legacy-source-supervisor-key-".repeat(2),
};
export const publisher = {
  generation: 1,
  facetNonce: "legacy-source-facet-nonce",
  publisherKey: "legacy-source-publisher-key-".repeat(2),
};
export const parentCheckpoint = {
  native: { id: "legacy-parent-native", sha256: "a".repeat(64), bytes: 4 },
  filesystem: { id: "legacy-parent-filesystem", sha256: "b".repeat(64), bytes: 4 },
};
export const finish = {
  sequence: 1,
  status: "completed" as const,
  result: { id: "legacy-result", sha256: "c".repeat(64), bytes: 4 },
  checkpoint: {
    native: { id: "legacy-finished-native", sha256: "d".repeat(64), bytes: 4 },
    filesystem: { id: "legacy-finished-filesystem", sha256: "e".repeat(64), bytes: 4 },
  },
};
export const request = {
  requestId: "legacy-source-step",
  input: { id: "legacy-input", sha256: "f".repeat(64), bytes: 4 },
};

export function createLegacyRunStoreFixture() {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
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
  const call = (command: unknown) =>
    Effect.runPromise(createHarnessRunStore(database, runId).execute(command));
  return {
    database,
    call,
    async completeSource() {
      await call({
        type: "initialize",
        seed: {
          identity: {
            runId,
            hostId: "host",
            threadId: "thread",
            logicalTurnId: "logical-turn",
            filesystemId: "filesystem",
          },
          locator: { id: "locator", sha256: "1".repeat(64), bytes: 1 },
          config: { id: "config", sha256: "2".repeat(64), bytes: 1 },
          artifacts: [],
        },
        controlKey,
        supervisorKey: supervisor.supervisorKey,
        claimId: supervisor.claimId,
        requestId: "legacy-source-initialize",
      });
      await call({
        type: "request.mode",
        runId,
        controlKey,
        requestId: "legacy-source-mode",
        checkpoint: parentCheckpoint,
      });
      await call({
        type: "request.replaceFacet",
        runId,
        controlKey,
        expectedGeneration: 0,
        operationId: "legacy-source-process-operation",
        facetNonce: publisher.facetNonce,
        publisherKey: publisher.publisherKey,
      });
      await call({ type: "request.offer", runId, supervisor, request });
      await call({ type: "request.admit", runId, publisher, requestId: request.requestId });
      await call({
        type: "request.finish",
        runId,
        publisher,
        requestId: request.requestId,
        finish,
      });
      return { runId, request, finish, publisher, parentCheckpoint, controlKey, supervisor };
    },
    close() {
      sqlite.close();
    },
  };
}

export async function createLegacyAdoptionFixture() {
  const runStore = createLegacyRunStoreFixture();
  const source = await runStore.completeSource();
  const control = {
    ownerId: "legacy-source-owner",
    incarnationId: "legacy-source-control-incarnation",
    epoch: 1,
    controlKey: "legacy-source-a-control-".repeat(2),
  };
  const aPublisher = {
    generation: 1,
    facetNonce: publisher.facetNonce,
    publisherKey: "legacy-source-a-publisher-".repeat(2),
  };
  const nativeSessionId = "legacy-source-native-session";
  const placement = {
    owner: "legacy-source-shard-owner",
    executionOperationId: "legacy-source-execution-operation",
    shardOwner: "legacy-source-shard-owner",
    shardIndex: 0,
    shardIncarnationNonce: "old-shard-incarnation-nonce",
  };
  const identity = {
    shardOwner: placement.shardOwner,
    loaderId: "legacy-source-facet-loader",
    facetKey: "legacy-source-facet-loader",
    incarnationNonce: "legacy-source-facet-incarnation",
  };
  const checkpoint = {
    checkpointId: finish.checkpoint.native.id,
    manifestSha256: finish.checkpoint.filesystem.sha256,
  };
  const supervisorReceipt = {
    action: "checkpointed" as const,
    snapshot: {
      runId,
      ownerId: control.ownerId,
      controlIncarnationId: control.incarnationId,
      controlEpoch: control.epoch,
      nativeSessionId,
      checkpoint,
      generation: aPublisher.generation,
      facetNonce: aPublisher.facetNonce,
      lifecycle: "accepting" as const,
      admittedStepId: null,
      preparedFacet: null,
      lastPublication: null,
      pendingControlSync: null,
      lastPublicationOperationId: null,
      stopAcknowledgementId: null,
      settlement: null,
      lastFailure: null,
      reconciliationEvidenceId: null,
      reconciliationExpectedGeneration: null,
      reconciliationAdmissionResolution: null,
      reconciliationOutcome: null,
      reconciliationCheckpoint: null,
      reconciliationInvocationSettlement: null,
      reconciliationPreparedFacetCleanup: null,
    },
    currentPublisher: aPublisher,
    preparedPublisher: null,
  };
  const completion = {
    status: "committed" as const,
    files: {
      action: "recorded" as const,
      checkpoint,
      parentCheckpointId: parentCheckpoint.native.id,
      activeStepId: null,
      admissionResolution: null,
      publication: null,
      files: [],
    },
    supervisor: supervisorReceipt,
  };
  const completionInput = {
    runId,
    processId: "legacy-source-process",
    executionOperationId: placement.executionOperationId,
    processOperationId: "legacy-source-process-operation",
    requestId: request.requestId,
    nativeSessionId,
    control,
    publisher: aPublisher,
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      parentCheckpointId: parentCheckpoint.native.id,
      files: [{ path: "native.json", mode: 0o644, bytes: new Uint8Array([1, 2, 3]) }],
    },
  };
  const terminal = {
    version: 1 as const,
    runId,
    processId: completionInput.processId,
    processOperationId: completionInput.processOperationId,
    request,
    nativeSessionId,
    control,
    publisher: aPublisher,
    placement,
    identity,
    finish,
    completion,
    acknowledgementId: "0".repeat(64),
    stopped: true as const,
    joined: { invocationRpc: true as const, fetch: true as const, ports: true as const },
  };
  const sourceTerminalKey = terminalKey(
    runId,
    terminal.processOperationId,
    terminal.request.requestId,
  );
  const sourceCompletionKey = `harness-process-completion/v1/${encodeURIComponent(runId)}/${encodeURIComponent(terminal.processOperationId)}/${encodeURIComponent(terminal.request.requestId)}`;
  const currentFence = {
    owner: placement.owner,
    incarnation: 2,
    nonce: "current-adoption-incarnation-nonce",
  };
  const values = new Map<string, unknown>([
    [sourceTerminalKey, terminal],
    [sourceCompletionKey, { input: completionInput, phase: "committed", result: completion }],
  ]);
  const storageApi = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async list(options?: { readonly prefix?: string; readonly limit?: number }) {
      const prefix = options?.prefix ?? "";
      const entries = [...values.entries()].filter(([key]) => key.startsWith(prefix));
      return new Map(entries.slice(0, options?.limit));
    },
    async transaction<A>(operation: (transaction: DurableObjectTransaction) => Promise<A>) {
      return operation(storageApi as unknown as DurableObjectTransaction);
    },
  };
  let aState: unknown = supervisorReceipt;
  const environment = {
    HARNESS_RUN_STORE: {
      getByName(name: string) {
        if (name !== runId) throw new Error("Unexpected RunStore name.");
        return {
          readProcessSource(auth: unknown, fence: unknown) {
            if (JSON.stringify(fence) !== JSON.stringify(currentFence))
              throw new Error("Wrong RunStore fence.");
            return readHarnessRunStoreProcessSource(runStore.database, name, auth);
          },
        };
      },
    },
    HARNESS_THREAD_SUPERVISOR: {
      getByName(name: string) {
        if (name !== runId) throw new Error("Unexpected supervisor name.");
        return {
          async execute(command: unknown, fence: unknown) {
            if (
              JSON.stringify(fence) !== JSON.stringify(currentFence) ||
              JSON.stringify(command) !== JSON.stringify({ type: "read", runId, control })
            )
              throw new Error("Unexpected supervisor read.");
            return structuredClone(aState);
          },
        };
      },
    },
  } as unknown as HarnessLegacyProcessSourceEnvironment;
  const operation: HarnessLegacyProcessSourceOperation = {
    runId,
    previousProcessId: completionInput.processId,
    previousOperationId: completionInput.processOperationId,
    previousStepId: request.requestId,
    runStore: {
      runId,
      processId: completionInput.processId,
      processOperationId: completionInput.processOperationId,
      transitionOperationId: "legacy-source-transition-operation",
      controlKey,
      supervisor,
      currentPublisher: publisher,
      nextPublisherKey: "legacy-source-next-publisher-".repeat(2),
      request,
      checkpoint: parentCheckpoint,
    },
    transition: { control, publisher: aPublisher },
  };
  return {
    runStore,
    source,
    operation,
    currentFence,
    terminal,
    terminalKey: sourceTerminalKey,
    completionKey: sourceCompletionKey,
    completion,
    values,
    setAState(value: unknown) {
      aState = value;
    },
    storage: storageApi as unknown as DurableObjectStorage,
    environment,
  };
}
