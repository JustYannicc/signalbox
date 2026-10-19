// @effect-diagnostics nodeBuiltinImport:off - disposable SQLite files verify persisted authority across reconstruction.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { afterEach } from "@effect/vitest";
import { createHarnessRunStore } from "../../HarnessRunStore.ts";
import type { HarnessRunDatabase } from "../../HarnessRunStore.ts";

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

export const reference = (id: string) => ({ id, sha256: "a".repeat(64), bytes: 4 });
export const runId = "run-one";
export const controlKey = "controller-secret-".repeat(3);
export const supervisorKey = "supervisor-one-key-".repeat(3);
export const replacementKey = "supervisor-two-key-".repeat(3);
export const publisherKey = "native-publisher-secret-".repeat(3);
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
export const declaration = {
  invocationId: "call-one",
  nativeIncarnationId: "native-one",
  requestId: "declare-one",
  locator: reference("same-call-locator"),
};
export const declare = { type: "declare", runId, supervisor, declaration, publisherKey };
export const publisher = {
  invocationId: declaration.invocationId,
  nativeIncarnationId: declaration.nativeIncarnationId,
  publisherKey,
};
export const progress = (sequence: number) => ({
  type: "progress",
  runId,
  publisher,
  progress: { sequence, kind: "native-output", reference: reference(`progress-${sequence}`) },
});
export const complete = (sequence: number) => ({
  type: "complete",
  runId,
  publisher,
  terminal: { sequence, status: "completed", reference: reference("native-result") },
});
export const receipt = (receiptId = "ready") => ({
  type: "receipt",
  runId,
  supervisor,
  receipt: {
    receiptId,
    kind: "seed-ready",
    subject: reference("executable"),
    evidence: reference("seed-receipt"),
  },
});
export const intent = (intentId = "control-one") => ({
  type: "intent",
  runId,
  supervisor,
  intent: { intentId, kind: "attach-same-call", reference: reference("same-call-locator") },
});

export function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "harness-run-store-"));
  const path = NodePath.join(directory, "run.sqlite");
  const handles = new Set<ReturnType<typeof open>>();
  const dispose = () => {
    for (const handle of handles) handle.close();
    NodeFS.rmSync(directory, { recursive: true });
  };
  cleanups.add(dispose);
  function open() {
    const sqlite = new NodeSqlite.DatabaseSync(path);
    let failWrite = false;
    let failInitialization = false;
    const database: HarnessRunDatabase = {
      sql: {
        exec(query, ...bindings) {
          const statement = sqlite.prepare(query);
          const result = statement.columns().length
            ? statement.all(...bindings)
            : (statement.run(...bindings), []);
          if (failWrite && query.startsWith("UPDATE harness_run_state")) {
            failWrite = false;
            throw new Error("Failure after writing, before commit");
          }
          if (failInitialization && query.startsWith("INSERT INTO harness_run_state")) {
            failInitialization = false;
            throw new Error("Failure before first initialization committed");
          }
          return result;
        },
      },
      transactionSync(operation) {
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
    };
    const handle = {
      // New service object for every operation, including operations from the same client.
      call: (command: unknown) =>
        Effect.runPromise(createHarnessRunStore(database, runId).execute(command)),
      exec: (query: string) => sqlite.exec(query),
      raw: () => sqlite.prepare("SELECT * FROM harness_run_state").get(),
      rows: (query: string) => sqlite.prepare(query).all(),
      failWrite: () => {
        failWrite = true;
      },
      failInitialization: () => {
        failInitialization = true;
      },
      close: () => {
        if (handles.delete(handle)) sqlite.close();
      },
    };
    handles.add(handle);
    return handle;
  }
  return { open };
}
